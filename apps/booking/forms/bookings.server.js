'use strict';

// Серверные функции формы "Бронирование".
//
// Экспортирует фабрику: module.exports = function(modelsDB, Utilities) { return { ... }; }
// Вызывается из init.js: loadServerScript('booking.bookingActions', require('./bookings.server')(modelsDB, Utilities), 'user')
//
// Каждая функция получает (params, ctx) где ctx = { sessionID, user, role }.

const i18n = require('../../../node_modules/my-old-space/drive_root/i18n');
const { resolveOrgReportLang } = require('../../organizationSettings/lib/orgReportLanguage');

module.exports = function (modelsDB, Utilities) {

    // ── Внутренний хелпер: строит строки счёта из данных ТЧ в памяти ────
    // Принимает уже загруженные массивы rooms/guests/roomServices (из tabularSections),
    // остальные справочники загружает из БД сам.
    async function _buildInvoiceLines({ bookingId, checkIn, checkOut, rooms, guests, roomServices, extraLines, orgId }, ctx) {
        const checkInDate  = new Date(checkIn);
        const checkOutDate = new Date(checkOut);
        const nights       = Math.round((checkOutDate - checkInDate) / 86400000);
        if (nights <= 0) return { lines: [] };

        // Строки счёта — часть ДОКУМЕНТА организации, поэтому их тексты (sectionLabel,
        // label) строятся на ЯЗЫКЕ ОРГАНИЗАЦИИ (organizationSettings → reportLanguage),
        // а НЕ на языке интерфейса текущего пользователя. Поэтому здесь НЕ используем
        // tForSession/tfForSession (они берут язык сессии) — резолвим язык организации
        // и переводим напрямую через i18n. Тот же язык берёт печать счёта (reports).
        const invLang = await resolveOrgReportLang(modelsDB, orgId);
        const tInv  = (key)       => i18n.t(key, invLang);
        const tfInv = (key, vars) => i18n.tf(key, invLang, vars);

        const guestTypes = await modelsDB.GuestTypes.findAll({ raw: true });
        const gtMap = {};
        for (const gt of guestTypes) gtMap[gt.UID] = gt;

        const roomIds  = rooms.map(r => r.roomId).filter(Boolean);
        const roomRecs = roomIds.length ? await modelsDB.Rooms.findAll({ where: { UID: roomIds }, raw: true }) : [];
        const roomMap  = {};
        for (const r of roomRecs) roomMap[r.UID] = r;

        const roomPrices = roomIds.length
            ? await modelsDB.RoomPrices.findAll({ where: { roomId: roomIds }, raw: true }) : [];

        const serviceIds = [...new Set(roomServices.map(s => s.serviceId).filter(Boolean))];
        const svcRecs    = serviceIds.length
            ? await modelsDB.Services.findAll({ where: { UID: serviceIds }, raw: true }) : [];
        const svcMap = {};
        for (const s of svcRecs) svcMap[s.UID] = s;

        const svcPrices = serviceIds.length
            ? await modelsDB.ServicePrices.findAll({ where: { serviceId: serviceIds }, raw: true }) : [];

        // Налоговые компоненты услуг (дробление одной услуги на несколько ставок НДС,
        // напр. завтрак → Speisen 7% + Getränke 19%). Если у услуги компонентов нет,
        // строка счёта остаётся одной (старое поведение). См. splitLineByComponents.
        const svcComponents = serviceIds.length
            ? await modelsDB.ServiceTaxComponents.findAll({ where: { serviceId: serviceIds }, raw: true }) : [];
        const compMap = {};
        for (const c of svcComponents) (compMap[c.serviceId] = compMap[c.serviceId] || []).push(c);
        for (const k of Object.keys(compMap)) {
            compMap[k].sort((a, b) => (a.displayOrder != null ? a.displayOrder : 50) - (b.displayOrder != null ? b.displayOrder : 50));
        }

        // Налоговые группы, справочник ставок-значений и привязки групп к ставкам
        // с датами действия (ставка — это ДАННЫЕ, не число в коде).
        // tax_rates           — плоский справочник значений (name «19%», rate 19)
        // tax_category_rates  — какая группа какую ставку имеет и с какой даты (rateId → tax_rates)
        const taxCats     = await modelsDB.TaxCategories.findAll({ raw: true });
        const taxCatRates = await modelsDB.TaxCategoryRates.findAll({ raw: true });
        const taxRateVals = await modelsDB.TaxRates.findAll({ raw: true });
        const catCodeToId = {};
        for (const c of taxCats) catCodeToId[c.code] = c.UID;
        const rateValById = {};
        for (const v of taxRateVals) rateValById[v.UID] = v.rate;

        const cleaningPrices = roomIds.length
            ? await modelsDB.ServicePrices.findAll({ where: { roomId: roomIds }, raw: true }) : [];

        const lines = [];
        let sortOrd = 0;
        const r2 = v => Math.round(v * 100) / 100;

        // Возвращает ставку налоговой группы, действующую на дату (берём дату заезда).
        // Привязка группа→ставка ищется в tax_category_rates по датам, само число — из tax_rates.
        // Если группа/привязка/значение не найдены — fallback (для обратной совместимости).
        function resolveRate(categoryId, fallback) {
            if (!categoryId) return fallback;
            let best = null;
            for (const r of taxCatRates) {
                if (r.taxCategoryId !== categoryId) continue;
                if (r.validFrom && new Date(r.validFrom) > checkInDate) continue;
                if (r.validTo   && new Date(r.validTo)   < checkInDate) continue;
                if (!best || new Date(r.validFrom || 0) > new Date(best.validFrom || 0)) best = r;
            }
            if (!best) return fallback;
            const val = rateValById[best.rateId];
            return (val != null) ? val : fallback;
        }
        const rateByCode = (code, fallback) => resolveRate(catCodeToId[code], fallback);
        // Ставка услуги — из её налоговой группы по дате заезда.
        const svcRate = svc => resolveRate(svc.taxCategoryId, 0);

        // Делит готовую строку услуги на несколько строк по налоговым компонентам.
        // Расчёт ведётся на уровне цены за единицу (unitPrice), поэтому корректен
        // и для "за ночь", и для возрастных групп. splitMode:
        //   percent   — splitValue % от unitPrice
        //   amount    — splitValue € (брутто) за единицу
        //   remainder — остаток (unitPrice − сумма прочих); поглощает округление
        // Если remainder-компонента нет, копеечный остаток уходит в последний компонент,
        // а итоговый дрейф суммы — в самый крупный, чтобы Σ частей == исходной строке.
        function splitLineByComponents(base, comps) {
            const qty  = base.quantity;
            const unit = base.unitPrice;
            const parts = comps.map(c => ({ c, unitPart: 0 }));
            let assigned = 0, remIdx = -1;
            for (let i = 0; i < parts.length; i++) {
                const c = parts[i].c;
                if (c.splitMode === 'remainder') { remIdx = i; continue; }
                const up = c.splitMode === 'amount'
                    ? r2(Number(c.splitValue) || 0)
                    : r2(unit * (Number(c.splitValue) || 0) / 100);
                parts[i].unitPart = up;
                assigned = r2(assigned + up);
            }
            if (remIdx >= 0) parts[remIdx].unitPart = r2(unit - assigned);
            else if (parts.length) {
                const last = parts[parts.length - 1];
                last.unitPart = r2(last.unitPart + (unit - assigned));
            }
            const out = [];
            let amtSum = 0;
            for (const { c, unitPart } of parts) {
                const amount = r2(unitPart * qty);
                out.push(Object.assign({}, base, {
                    UID: Utilities.generateUID('InvoiceLines'),
                    label: (base.label || '') + ' – ' + c.name,
                    unitPrice: unitPart,
                    taxRate: resolveRate(c.taxCategoryId, base.taxRate),
                    amount
                }));
                amtSum = r2(amtSum + amount);
            }
            const drift = r2(base.amount - amtSum);
            if (drift !== 0 && out.length) {
                let mx = 0;
                for (let i = 1; i < out.length; i++) if (out[i].amount > out[mx].amount) mx = i;
                out[mx].amount = r2(out[mx].amount + drift);
            }
            return out;
        }

        // Компонент действует на дату оказания услуги (validFrom/validTo, обе границы включительно).
        // Дата услуги для гейтинга — дата заезда (checkInDate). Пограничные брони, у которых
        // ночи попадают по разные стороны от даты реформы, считаются по дате заезда целиком —
        // помесячная/поночёвочная точность отложена (см. project-vat-component-splitting).
        function componentApplies(c) {
            if (c.validFrom && new Date(c.validFrom) > checkInDate) return false;
            if (c.validTo   && new Date(c.validTo)   < checkInDate) return false;
            return true;
        }

        // Кладёт строку услуги в счёт: либо как есть, либо разбитой на действующие на дату
        // налоговые компоненты. Если на дату услуги ни один компонент не действует
        // (напр. завтрак до 01.01.2026) — строка остаётся одной, со ставкой из группы услуги.
        function emitServiceLine(base, serviceId) {
            const all = compMap[serviceId];
            const comps = all ? all.filter(componentApplies) : null;
            if (!comps || comps.length === 0) { lines.push(base); return; }
            for (const ln of splitLineByComponents(base, comps)) lines.push(ln);
        }

        for (const room of rooms) {
            if (!room.UID) continue;
            const rGuests = guests.filter(g => g.bookingRoomId === room.UID);
            const rSvcs   = roomServices.filter(s => s.bookingRoomId === room.UID);
            const rInfo   = roomMap[room.roomId];
            const rLabel  = rInfo ? rInfo.number : '?';

            let adults = 0, kids6_15 = 0, kids3_5 = 0, kids2 = 0, infants = 0;
            for (const g of rGuests) {
                const gt = gtMap[g.guestTypeId];
                if (!gt) continue;
                const c = g.count || 1;
                if      (gt.ageFrom >= 16) adults   += c;
                else if (gt.ageFrom >= 6)  kids6_15 += c;
                else if (gt.ageFrom >= 3)  kids3_5  += c;
                else if (gt.ageFrom >= 2)  kids2    += c;
                else                       infants  += c;
            }
            const billingGuests = adults + kids6_15;

            // 1. Проживание
            const rp = roomPrices.find(p =>
                p.roomId === room.roomId &&
                p.guestsCount === billingGuests &&
                new Date(p.dateFrom) <= checkInDate && new Date(p.dateTo) >= checkInDate
            );
            if (rp) {
                lines.push({
                    UID: Utilities.generateUID('InvoiceLines'),
                    bookingId, bookingRoomId: room.UID, organizationId: orgId,
                    sectionLabel: tInv('accommodation_section'),
                    label:    tfInv('room_line_label', { room: rLabel, guests: billingGuests, nights }),
                    quantity: nights, unitPrice: rp.price,
                    taxRate:  rateByCode('accommodation', 0),
                    amount:   r2(rp.price * nights), sortOrder: ++sortOrd
                });
            }

            // 2. Дети 3–5 лет
            if (kids3_5 > 0) {
                const qty = kids3_5 * nights;
                lines.push({
                    UID: Utilities.generateUID('InvoiceLines'),
                    bookingId, bookingRoomId: room.UID, organizationId: orgId,
                    guestTypeId: '000000000-guest-type-0003',
                    sectionLabel: tInv('accommodation_section'),
                    label:    tfInv('children_3_5_line_label', { count: kids3_5, nights }),
                    quantity: qty, unitPrice: 10, taxRate: rateByCode('accommodation', 0),
                    amount:   r2(qty * 10), sortOrder: ++sortOrd
                });
            }

            // 2б. Дети 2 лет
            if (kids2 > 0) {
                const qty2 = kids2 * nights;
                lines.push({
                    UID: Utilities.generateUID('InvoiceLines'),
                    bookingId, bookingRoomId: room.UID, organizationId: orgId,
                    guestTypeId: '000000000-guest-type-0005',
                    sectionLabel: tInv('accommodation_section'),
                    label:    tfInv('children_2_line_label', { count: kids2, nights }),
                    quantity: qty2, unitPrice: 10, taxRate: rateByCode('accommodation', 0),
                    amount:   r2(qty2 * 10), sortOrder: ++sortOrd
                });
            }

            // 3. Курортный сбор
            if (adults > 0) {
                const qty = adults * nights;
                lines.push({
                    UID: Utilities.generateUID('InvoiceLines'),
                    bookingId, bookingRoomId: room.UID, organizationId: orgId,
                    guestTypeId: '000000000-guest-type-0001',
                    sectionLabel: tInv('resort_fee_section'),
                    label:    tfInv('adults_resort_fee_label', { count: adults, nights }),
                    quantity: qty, unitPrice: 2.10, taxRate: rateByCode('exempt', 0),
                    amount:   r2(qty * 2.10), sortOrder: ++sortOrd
                });
            }
            if (kids6_15 > 0) {
                const qty = kids6_15 * nights;
                lines.push({
                    UID: Utilities.generateUID('InvoiceLines'),
                    bookingId, bookingRoomId: room.UID, organizationId: orgId,
                    guestTypeId: '000000000-guest-type-0002',
                    sectionLabel: tInv('resort_fee_section'),
                    label:    tfInv('children_6_15_resort_fee_label', { count: kids6_15, nights }),
                    quantity: qty, unitPrice: 1.00, taxRate: rateByCode('exempt', 0),
                    amount:   r2(qty * 1.00), sortOrder: ++sortOrd
                });
            }

            // 4. Услуги из BookingRoomServices
            for (const rs of rSvcs) {
                const svc = svcMap[rs.serviceId];
                if (!svc) continue;
                const cnt = Number(rs.count);
                if (!cnt) continue;
                const agePrices = svcPrices.filter(sp =>
                    sp.serviceId === rs.serviceId && sp.ageFrom != null
                );

                if (agePrices.length > 0 && svc.chargeType === 'per_night') {
                    const groups = [
                        { gtId: '000000000-guest-type-0001', n: adults,   lblKey: 'age_group_adults_abbr' },
                        { gtId: '000000000-guest-type-0002', n: kids6_15, lblKey: 'age_group_6_15_abbr' },
                        { gtId: '000000000-guest-type-0003', n: kids3_5,  lblKey: 'age_group_3_5_abbr'  },
                        { gtId: '000000000-guest-type-0005', n: kids2,    lblKey: 'age_group_2_abbr'   },
                        { gtId: '000000000-guest-type-0004', n: infants,  lblKey: 'age_group_0_1_abbr'  },
                    ];
                    for (const ag of groups) {
                        if (ag.n <= 0) continue;
                        const gt = gtMap[ag.gtId];
                        if (!gt) continue;
                        const sp = agePrices.find(p =>
                            p.ageFrom <= gt.ageFrom &&
                            (p.ageTo == null || p.ageTo >= (gt.ageTo != null ? gt.ageTo : gt.ageFrom))
                        );
                        if (!sp || sp.price === 0) continue;
                        const qty = ag.n * cnt * nights;
                        emitServiceLine({
                            UID: Utilities.generateUID('InvoiceLines'),
                            bookingId, bookingRoomId: room.UID, organizationId: orgId,
                            serviceId: rs.serviceId, guestTypeId: ag.gtId,
                            sectionLabel: svc.name,
                            label:    tfInv('service_age_group_per_night_label', { name: svc.name, ageGroup: tInv(ag.lblKey), count: ag.n, perRoom: cnt, nights }),
                            quantity: qty, unitPrice: sp.price, taxRate: svcRate(svc),
                            amount:   r2(qty * sp.price), sortOrder: ++sortOrd
                        }, rs.serviceId);
                    }
                } else {
                    const sp    = svcPrices.find(p => p.serviceId === rs.serviceId && p.ageFrom == null);
                    const price = sp ? sp.price : 0;
                    if (price > 0) {
                        const qty = svc.chargeType === 'per_night' ? cnt * nights : cnt;
                        const svcLabel = svc.chargeType === 'per_night'
                            ? tfInv('service_per_night_label', { name: svc.name, count: cnt, nights })
                            : tfInv('service_once_label',      { name: svc.name, count: cnt });
                        emitServiceLine({
                            UID: Utilities.generateUID('InvoiceLines'),
                            bookingId, bookingRoomId: room.UID, organizationId: orgId,
                            serviceId: rs.serviceId, sectionLabel: svc.name,
                            label:    svcLabel,
                            quantity: qty, unitPrice: price, taxRate: svcRate(svc),
                            amount:   r2(qty * price), sortOrder: ++sortOrd
                        }, rs.serviceId);
                    }
                }
            }

            // 5. Финальная уборка (Endreinigung) при <=3 ночей
            if (nights <= 3) {
                const csp = cleaningPrices.find(sp => sp.roomId === room.roomId);
                if (csp) {
                    lines.push({
                        UID: Utilities.generateUID('InvoiceLines'),
                        bookingId, bookingRoomId: room.UID, organizationId: orgId,
                        serviceId: csp.serviceId || null,
                        sectionLabel: tInv('accommodation_section'),
                        label:    tfInv('final_cleaning_label', { room: rLabel }),
                        quantity: 1, unitPrice: csp.price, taxRate: rateByCode('accommodation', 0),
                        amount:   csp.price, sortOrder: ++sortOrd
                    });
                }
            }
        }

        // 6. Доп.услуги (booking_extra_lines): добавляются прямо в счёт отдельными
        // строками. Сумма задаётся брутто, ставка — из справочника tax_rates (поле taxRateId).
        for (const el of (extraLines || [])) {
            if (!el || !el.name) continue;
            const amount = Number(el.amount);
            if (!Number.isFinite(amount) || amount === 0) continue;
            const rate = el.taxRateId && rateValById[el.taxRateId] != null ? rateValById[el.taxRateId] : 0;
            lines.push({
                UID: Utilities.generateUID('InvoiceLines'),
                bookingId, organizationId: orgId,
                sectionLabel: tInv('extra_lines_section'),
                label:    el.name,
                quantity: 1, unitPrice: r2(amount),
                taxRate:  rate,
                amount:   r2(amount), sortOrder: ++sortOrd,
                _isExtra: true
            });
        }

        // Назначаем приоритет сортировки из displayOrder справочников
        for (const ln of lines) {
            if (ln._isExtra) {
                ln._sortPriority = 95; // доп.услуги — в самом конце счёта
            } else if (ln.serviceId != null) {
                const svc = svcMap[ln.serviceId];
                ln._sortPriority = (svc && svc.displayOrder != null) ? svc.displayOrder : 50;
            } else if (ln.guestTypeId != null) {
                const gt = gtMap[ln.guestTypeId];
                ln._sortPriority = (gt && gt.displayOrder != null) ? gt.displayOrder : 50;
            } else {
                ln._sortPriority = 10; // Zimmer — проживание, всегда первым
            }
        }
        lines.sort((a, b) => {
            if (a._sortPriority !== b._sortPriority) return a._sortPriority - b._sortPriority;
            return (a.label || '').localeCompare(b.label || '', 'de');
        });
        lines.forEach((ln, i) => {
            ln.sortOrder = i + 1;
            delete ln._sortPriority;
            delete ln._isExtra;
        });
        return { lines };
    }

    return {

        // ── Серверное событие формы ──────────────────────────────────────
        // Вызывается ДО записи в БД.
        // 1. Заполняем organizationId в основной записи и во все строки ТЧ.
        // 2. Пересчитываем строки счёта (invoice_lines) на основе актуальных ТЧ.
        async onBeforeSave({ record, changes, tabularSections, parentUID }, ctx) {
            // 1. organizationId
            if (!changes.organizationId) {
                try {
                    const globalCtx = require('../../../node_modules/my-old-space/drive_root/globalServerContext');
                    const user = await globalCtx.getUserBySessionID(ctx.sessionID);
                    if (user && user.organizationId) {
                        changes.organizationId = user.organizationId;
                    }
                } catch (e) {
                    console.warn('[booking/onBeforeSave] Could not resolve user org:', e && e.message);
                }
            }

            const orgId = changes.organizationId || (record && record.organizationId);
            if (orgId) {
                for (const rows of Object.values(tabularSections)) {
                    for (const row of rows) {
                        if (!row.organizationId) row.organizationId = orgId;
                    }
                }
            }

            // 2. Пересчёт строк счёта из данных ТЧ (до записи в БД)
            try {
                // record приходит null из dispatchServerEvent — читаем из БД по parentUID.
                // changes содержит только изменённые поля, parentUID — всегда актуальный UID записи.
                const bookingId = parentUID || (changes && changes.UID);
                let dbRecord = null;
                if (bookingId) {
                    try { dbRecord = await modelsDB.Bookings.findByPk(bookingId, { raw: true }); } catch(_) {}
                }
                const effective = Object.assign({}, dbRecord || {}, changes || {});
                const checkIn      = effective.checkIn;
                const checkOut     = effective.checkOut;
                const rooms        = (tabularSections.booking_rooms || []).filter(r => r && r.UID);

                // Удаляем из зависимых ТЧ строки, ссылающиеся на удалённые номера.
                // Иначе при DELETE booking_rooms (CASCADE) + INSERT guests с устаревшим
                // bookingRoomId возникает FK violation / security-check warning.
                const survivingRoomUIDs = new Set(rooms.map(r => r.UID));
                tabularSections.booking_guests = (tabularSections.booking_guests || []).filter(
                    g => g.bookingRoomId && survivingRoomUIDs.has(g.bookingRoomId)
                );
                tabularSections.booking_room_services = (tabularSections.booking_room_services || []).filter(
                    s => s.bookingRoomId && survivingRoomUIDs.has(s.bookingRoomId)
                );

                // count услуги — числовое количество (числовое поле с "+"). Старые брони
                // могли хранить его как boolean (бывшая галочка "Включено") — коэрцим в 0/1.
                for (const rs of tabularSections.booking_room_services) {
                    if (typeof rs.count === 'boolean') rs.count = rs.count ? 1 : 0;
                }

                const guests       = tabularSections.booking_guests;
                const roomServices = tabularSections.booking_room_services;
                const extraLines   = tabularSections.booking_extra_lines || [];

                if (bookingId && checkIn && checkOut && (rooms.length > 0 || extraLines.length > 0)) {
                    const { lines } = await _buildInvoiceLines(
                        { bookingId, checkIn, checkOut, rooms, guests, roomServices, extraLines, orgId },
                        ctx
                    );
                    tabularSections.invoice_lines = lines;
                } else {
                    tabularSections.invoice_lines = [];
                }
            } catch (e) {
                console.error('[booking/onBeforeSave] Invoice calculation failed:', e && e.message || e);
            }
        },

        // ── Возвращает дефолтные услуги для отеля (для автозаполнения при выборе гостя) ──
        async getDefaultServices({ hotelId, bookingRoomId }, ctx) {
            if (!hotelId) return { services: [] };
            // Если для этого номера услуги уже есть в БД — не добавляем повторно
            if (bookingRoomId) {
                const existing = await modelsDB.BookingRoomServices.count({ where: { bookingRoomId } });
                if (existing > 0) return { services: [] };
            }
            const defaults = await modelsDB.HotelDefaultServices.findAll({
                where: { hotelId }, order: [['displayOrder', 'ASC']], raw: true
            });
            if (!defaults.length) return { services: [] };
            const serviceIds = defaults.map(d => d.serviceId);
            const services = await modelsDB.Services.findAll({ where: { UID: serviceIds }, raw: true });
            const svcMap2 = {};
            for (const s of services) svcMap2[s.UID] = s;
            return {
                services: defaults.map(d => ({
                    serviceId: d.serviceId,
                    serviceName: (svcMap2[d.serviceId] && svcMap2[d.serviceId].name) || ''
                }))
            };
        },

        // ── Налоговая ставка по умолчанию из настроек организации ──────────
        // Читает настройку defaultTaxRate (organizationSettings) для организации
        // брони и возвращает UID ставки + отображаемое имя для новой строки доп.услуг.
        async getOrgDefaultTaxRate({ organizationId }, ctx) {
            try {
                let orgId = organizationId;
                if (!orgId) {
                    const globalCtx = require('../../../node_modules/my-old-space/drive_root/globalServerContext');
                    const user = await globalCtx.getUserBySessionID(ctx.sessionID);
                    orgId = user && user.organizationId;
                    // users.organizationId может быть пустым — берём первую из user_organizations
                    if (!orgId && user && modelsDB.UserOrganizations) {
                        const orgs = await modelsDB.UserOrganizations.findAll({ where: { userId: user.UID }, raw: true });
                        if (orgs && orgs.length) orgId = orgs[0].organizationId;
                    }
                }
                if (!orgId || !modelsDB.OrganizationSettingsFields) return { taxRateId: null, taxRateName: '' };

                const field = await modelsDB.OrganizationSettingsFields.findOne({ where: { name: 'defaultTaxRate' }, raw: true });
                if (!field) return { taxRateId: null, taxRateName: '' };

                const rec = await modelsDB.OrganizationSettingsStringValues.findOne({
                    where: { organizationId: orgId, settingsFieldId: field.UID }, raw: true
                });
                const taxRateId = rec ? rec.value : null;
                if (!taxRateId) return { taxRateId: null, taxRateName: '' };

                const rate = await modelsDB.TaxRates.findByPk(taxRateId, { raw: true });
                return { taxRateId, taxRateName: rate ? rate.name : '' };
            } catch (e) {
                console.warn('[booking/getOrgDefaultTaxRate]', e && e.message);
                return { taxRateId: null, taxRateName: '' };
            }
        },

    };
};