'use strict';

// Серверные функции формы «Счёт» (документ invoices).
//
// Экспортирует фабрику: module.exports = function(modelsDB, Utilities) { return { ... }; }
// Вызывается из init.js: loadServerScript('invoice.actions', require('./invoices.server')(modelsDB, Utilities), 'user')
//
// Каждая функция получает (params, ctx) где ctx = { sessionID, user, role }.
//
// Расчёт строк (_buildInvoiceLines) переехал сюда из apps/booking/forms/bookings.server.js:
// счёт — самостоятельный документ, строит свои строки сам (кнопка «Заполнить» /
// создание из брони), сохранение брони счета больше НЕ трогает. Данные брони
// (шапка + ТЧ) читаются из БД по bookingId, цены — только через priceResolver
// (срез прайс-листов на дату ценообразования). Ставки НДС по-прежнему резолвятся
// по дате ОКАЗАНИЯ услуги (дата заезда брони) — периодичность касается только цен.

const i18n = require('../../../node_modules/my-old-space/drive_root/i18n');
const { tForSession } = require('../../../node_modules/my-old-space/drive_forms/globalServerContext');
const { resolveOrgReportLang } = require('../../organizationSettings/lib/orgReportLanguage');
const { resolveOrgPricingMode } = require('../../organizationSettings/lib/orgPricingMode');
const dbGateway = require('../../../node_modules/my-old-space/drive_root/dbGateway');

module.exports = function (modelsDB, Utilities) {

    // Цены проживания и услуг — ТОЛЬКО через резолвер прайс-листов.
    const priceResolver = require('../../common/lib/priceResolver')(modelsDB);

    const r2 = v => Math.round(v * 100) / 100;
    const fmtD = (v) => {
        if (!v) return '';
        const dt = new Date(v);
        if (isNaN(dt.getTime())) return String(v);
        const p = n => String(n).padStart(2, '0');
        return `${p(dt.getDate())}.${p(dt.getMonth() + 1)}.${dt.getFullYear()}`;
    };

    // SSE-оповещение подписанных списков (журнал счетов, вкладка «Счета» брони).
    // fillInvoice/createFromBooking меняют данные мимо applyChanges — оповещаем сами.
    function notifyTables(action, invoiceId) {
        try {
            const uniForm = require('../../../node_modules/my-old-space/apps/uniForm/server.js');
            uniForm.notifyTableChange('invoices', action, invoiceId);
            uniForm.notifyTableChange('invoice_bookings', action, null);
            uniForm.notifyTableChange('invoice_lines', action, null);
        } catch (e) {
            console.warn('[invoice/notifyTables]', e && e.message);
        }
    }

    // ── Построение строк счёта по ОДНОЙ брони ────────────────────────────
    // Данные брони читаются из БД (шапка + ТЧ rooms/guests/roomServices/extraLines).
    // pricingDate — дата ценообразования (дата брони или дата счёта, см. fillInvoice).
    // Возвращает { lines } — строки БЕЗ invoiceId и БЕЗ сквозного sortOrder
    // (их проставляет fillInvoice).
    async function _buildInvoiceLines({ bookingId, pricingDate }, ctx) {
        const booking = await modelsDB.Bookings.findByPk(bookingId, { raw: true });
        if (!booking) return { lines: [] };

        const orgId   = booking.organizationId;
        const hotelId = booking.hotelId;
        const checkInDate  = new Date(booking.checkIn);
        const checkOutDate = new Date(booking.checkOut);
        const nights       = Math.round((checkOutDate - checkInDate) / 86400000);
        if (!isFinite(nights) || nights <= 0) return { lines: [] };

        const [rooms, guests, roomServices, extraLines] = await Promise.all([
            modelsDB.BookingRooms.findAll({ where: { bookingId }, raw: true }),
            modelsDB.BookingGuests.findAll({ where: { bookingId }, raw: true }),
            modelsDB.BookingRoomServices.findAll({ where: { bookingId }, raw: true }),
            modelsDB.BookingExtraLines.findAll({ where: { bookingId }, raw: true })
        ]);

        // Строки счёта — часть ДОКУМЕНТА организации: тексты (sectionLabel, label)
        // строятся на ЯЗЫКЕ ОРГАНИЗАЦИИ (reportLanguage), НЕ на языке сессии.
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

        // Срез прайс-листов на дату ценообразования — один на всю бронь.
        const priceSlice = await priceResolver.loadSlice({
            organizationId: orgId, hotelId, pricingDate
        });

        const serviceIds = [...new Set(roomServices.map(s => s.serviceId).filter(Boolean))];
        const svcRecs    = serviceIds.length
            ? await modelsDB.Services.findAll({ where: { UID: serviceIds }, raw: true }) : [];
        const svcMap = {};
        for (const s of svcRecs) svcMap[s.UID] = s;

        // Актуальные полосы цен услуг («срез последних» по позициям услуги).
        const svcPrices = [];
        for (const sid of serviceIds) {
            svcPrices.push(...priceResolver.pickServicePrices(priceSlice, { serviceId: sid }));
        }

        // Налоговые компоненты услуг (дробление одной услуги на несколько ставок НДС).
        const svcComponents = serviceIds.length
            ? await modelsDB.ServiceTaxComponents.findAll({ where: { serviceId: serviceIds }, raw: true }) : [];
        const compMap = {};
        for (const c of svcComponents) (compMap[c.serviceId] = compMap[c.serviceId] || []).push(c);
        for (const k of Object.keys(compMap)) {
            compMap[k].sort((a, b) => (a.displayOrder != null ? a.displayOrder : 50) - (b.displayOrder != null ? b.displayOrder : 50));
        }

        // Налоговые группы и ставки (ставка — ДАННЫЕ, резолв по дате заезда).
        const taxCats     = await modelsDB.TaxCategories.findAll({ raw: true });
        const taxCatRates = await modelsDB.TaxCategoryRates.findAll({ raw: true });
        const taxRateVals = await modelsDB.TaxRates.findAll({ raw: true });
        const catCodeToId = {};
        for (const c of taxCats) catCodeToId[c.code] = c.UID;
        const rateValById = {};
        for (const v of taxRateVals) rateValById[v.UID] = v.rate;

        // Полосы цен услуги для конкретной комнаты (покомнатные → иначе общие).
        const pricesForRoom = (serviceId, roomId) => {
            const rows = svcPrices.filter(p => p.serviceId === serviceId);
            const roomRows = rows.filter(p => p.roomId === roomId);
            return roomRows.length ? roomRows : rows.filter(p => p.roomId == null);
        };

        // Детский тариф проживания — сумма из прайс-листа (позиция srv-child).
        const CHILD_SERVICE_ID = 'srv-child';
        const auxPrices = priceResolver.pickServicePrices(priceSlice, { serviceId: CHILD_SERVICE_ID });
        const auxPriceByAge = (serviceId, age, fallback) => {
            const p = auxPrices.find(x => x.serviceId === serviceId
                && (x.ageFrom == null || x.ageFrom <= age)
                && (x.ageTo == null || x.ageTo >= age));
            return p ? p.price : fallback;
        };
        const childNightPrice = auxPriceByAge(CHILD_SERVICE_ID, 3, 10);     // Kinder 2–5: 10 €/Nacht

        const lines = [];
        let sortOrd = 0;

        // Ставка налоговой группы на дату ЗАЕЗДА (дата оказания услуги).
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
        const svcRate = svc => resolveRate(svc.taxCategoryId, 0);

        // Делит строку услуги на компоненты НДС (percent/amount/remainder),
        // поглощая копеечный дрейф. Логика без изменений (см. историю в booking).
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
                    taxComponentName: c.name,
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

        // Компонент действует, если дата услуги (заезд) попадает в validFrom..validTo.
        function componentApplies(c) {
            if (c.validFrom && new Date(c.validFrom) > checkInDate) return false;
            if (c.validTo   && new Date(c.validTo)   < checkInDate) return false;
            return true;
        }

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

            // Возрастные группы = виды гостей (границы 13/14 и 15/16 — разные полосы).
            let adults = 0, teen14_15 = 0, kids6_13 = 0, kids3_5 = 0, kids2 = 0, infants = 0;
            for (const g of rGuests) {
                const gt = gtMap[g.guestTypeId];
                if (!gt) continue;
                const c = g.count || 1;
                if      (gt.ageFrom >= 16) adults    += c;
                else if (gt.ageFrom >= 14) teen14_15 += c;
                else if (gt.ageFrom >= 6)  kids6_13  += c;
                else if (gt.ageFrom >= 3)  kids3_5   += c;
                else if (gt.ageFrom >= 2)  kids2     += c;
                else                       infants   += c;
            }
            const billingGuests = adults + teen14_15 + kids6_13;

            // 1. Проживание — цена из среза прайс-листов.
            const rp = priceResolver.pickRoomPrice(priceSlice, {
                roomId: room.roomId, guestsCount: billingGuests, stayDate: checkInDate
            });
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
                    label:    tfInv('children_3_5_line_label', { room: rLabel, count: kids3_5, nights }),
                    quantity: qty, unitPrice: childNightPrice, taxRate: rateByCode('accommodation', 0),
                    amount:   r2(qty * childNightPrice), sortOrder: ++sortOrd
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
                    label:    tfInv('children_2_line_label', { room: rLabel, count: kids2, nights }),
                    quantity: qty2, unitPrice: childNightPrice, taxRate: rateByCode('accommodation', 0),
                    amount:   r2(qty2 * childNightPrice), sortOrder: ++sortOrd
                });
            }

            // 3. Услуги из BookingRoomServices (только «включённые», count > 0).
            for (const rs of rSvcs) {
                if (rs.included === false) continue;
                const svc = svcMap[rs.serviceId];
                if (!svc) continue;
                const cnt = Number(rs.count);
                if (!cnt) continue;
                const roomPriceRows = pricesForRoom(rs.serviceId, room.roomId);
                const agePrices = roomPriceRows.filter(sp => sp.ageFrom != null);

                if (agePrices.length > 0) {
                    const groups = [
                        { gtId: '000000000-guest-type-0001', n: adults,    lblKey: 'age_group_adults_abbr' },
                        { gtId: '000000000-guest-type-0006', n: teen14_15, lblKey: 'age_group_14_15_abbr' },
                        { gtId: '000000000-guest-type-0002', n: kids6_13,  lblKey: 'age_group_6_13_abbr'  },
                        { gtId: '000000000-guest-type-0003', n: kids3_5,   lblKey: 'age_group_3_5_abbr'  },
                        { gtId: '000000000-guest-type-0005', n: kids2,     lblKey: 'age_group_2_abbr'   },
                        { gtId: '000000000-guest-type-0004', n: infants,   lblKey: 'age_group_0_1_abbr'  },
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
                        const qty = ag.n * cnt;
                        const ageLabel = tfInv('service_age_group_label', { name: svc.name, ageGroup: tInv(ag.lblKey), count: ag.n, perRoom: cnt });
                        emitServiceLine({
                            UID: Utilities.generateUID('InvoiceLines'),
                            bookingId, bookingRoomId: room.UID, organizationId: orgId,
                            serviceId: rs.serviceId, guestTypeId: ag.gtId,
                            sectionLabel: svc.name,
                            label:    ageLabel,
                            quantity: qty, unitPrice: sp.price, taxRate: svcRate(svc),
                            amount:   r2(qty * sp.price), sortOrder: ++sortOrd
                        }, rs.serviceId);
                    }
                } else {
                    const sp    = roomPriceRows.find(p => p.ageFrom == null);
                    const price = sp ? sp.price : 0;
                    if (price > 0) {
                        const qty = cnt;
                        const svcLabel = tfInv('service_once_label', { name: svc.name, count: cnt });
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
        }

        // 6. Доп.услуги (booking_extra_lines) — прямо в счёт отдельными строками.
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

        // Приоритет сортировки из displayOrder справочников.
        for (const ln of lines) {
            if (ln._isExtra) {
                ln._sortPriority = 95;
            } else if (ln.serviceId != null) {
                const svc = svcMap[ln.serviceId];
                ln._sortPriority = (svc && svc.displayOrder != null) ? svc.displayOrder : 50;
            } else if (ln.guestTypeId != null) {
                const gt = gtMap[ln.guestTypeId];
                ln._sortPriority = (gt && gt.displayOrder != null) ? gt.displayOrder : 50;
            } else {
                ln._sortPriority = 10; // проживание — всегда первым
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
        return { lines, booking };
    }

    // ── Перезаполнение строк счёта по ТЧ «Бронирования» ──────────────────
    // Режим даты ценообразования — из настроек организации (pricingDateMode):
    //   bookingDate → дата документа каждой брони (своя на бронь);
    //   invoiceDate → дата документа счёта (одна на весь счёт).
    // Старые строки удаляются, новые пишутся; prepayment счёта = Σ prepayment
    // броней (только при заполнении — дальше пользователь правит сам).
    async function _fillInvoice(invoiceId, ctx) {
        const invoice = await modelsDB.Invoices.findByPk(invoiceId, { raw: true });
        if (!invoice) throw new Error(await tForSession('invoice_not_found', ctx.sessionID));

        const links = await modelsDB.InvoiceBookings.findAll({
            where: { invoiceId }, order: [['createdAt', 'ASC']], raw: true
        });
        const bookingIds = [...new Set(links.map(l => l.bookingId).filter(Boolean))];

        const mode = await resolveOrgPricingMode(modelsDB, invoice.organizationId);
        const invLang = await resolveOrgReportLang(modelsDB, invoice.organizationId);

        const allLines = [];
        let prepaymentSum = 0;
        for (const bookingId of bookingIds) {
            const booking = await modelsDB.Bookings.findByPk(bookingId, { raw: true });
            if (!booking) continue;
            const pricingDate = (mode === 'invoiceDate')
                ? (invoice.date || new Date())
                : (booking.date || invoice.date || new Date());
            const { lines } = await _buildInvoiceLines({ bookingId, pricingDate }, ctx);
            prepaymentSum = r2(prepaymentSum + (Number(booking.prepayment) || 0));

            // При нескольких бронях первая строка группы несёт идентификацию брони
            // (на языке организации) — по ней же секционируется печать.
            if (bookingIds.length > 1 && lines.length) {
                lines[0].sectionLabel = i18n.tf('invoice_booking_section', invLang, {
                    number: booking.number || '', from: fmtD(booking.checkIn), to: fmtD(booking.checkOut)
                });
            }
            allLines.push(...lines);
        }
        allLines.forEach((ln, i) => {
            ln.invoiceId = invoiceId;
            ln.sortOrder = i + 1;
            if (!ln.organizationId) ln.organizationId = invoice.organizationId;
        });

        // Перезапись строк — через dbGateway (RLS/хуки), не прямым Model.destroy/bulkCreate.
        const dbCtx = { sessionID: ctx.sessionID };
        await dbGateway.execute({ operation: 'delete', table: 'invoice_lines', where: { invoiceId }, context: dbCtx });
        for (const ln of allLines) {
            await dbGateway.execute({ operation: 'create', table: 'invoice_lines', data: ln, context: dbCtx });
        }
        await dbGateway.execute({
            operation: 'update', table: 'invoices',
            where: { UID: invoiceId }, data: { prepayment: prepaymentSum },
            context: dbCtx
        });

        notifyTables('update', invoiceId);
        const freshInvoice = await modelsDB.Invoices.findByPk(invoiceId, { raw: true });
        return { invoice: freshInvoice, lines: allLines };
    }

    return {

        // ── RPC: «Заполнить» — перезаполняет строки счёта из его броней ───
        async fillInvoice({ invoiceId }, ctx) {
            if (!invoiceId) return { error: await tForSession('invoice_not_found', ctx.sessionID) };
            try {
                return await _fillInvoice(invoiceId, ctx);
            } catch (e) {
                return { error: (e && e.message) || String(e) };
            }
        },

        // ── RPC: создание счёта из брони (кнопка «Создать счёт») ──────────
        // Создание — через dbGateway (тот же путь, что applyChanges): срабатывают
        // автонумерация (number), системная дата (date), представление (name) и RLS.
        async createFromBooking({ bookingId }, ctx) {
            if (!bookingId) return { error: await tForSession('booking_not_found', ctx.sessionID) };
            const booking = await modelsDB.Bookings.findByPk(bookingId, { raw: true });
            if (!booking) return { error: await tForSession('booking_not_found', ctx.sessionID) };

            const dbCtx = { sessionID: ctx.sessionID };
            const invoiceId = Utilities.generateUID('Invoices');
            try {
                await dbGateway.execute({
                    operation: 'create', table: 'invoices',
                    data: {
                        UID: invoiceId,
                        organizationId: booking.organizationId,
                        hotelId:        booking.hotelId,
                        clientId:       booking.clientId,
                        status:         'draft',
                        prepayment:     Number(booking.prepayment) || 0
                    },
                    context: dbCtx
                });
                await dbGateway.execute({
                    operation: 'create', table: 'invoice_bookings',
                    data: {
                        UID: Utilities.generateUID('InvoiceBookings'),
                        organizationId: booking.organizationId,
                        invoiceId, bookingId
                    },
                    context: dbCtx
                });
                await _fillInvoice(invoiceId, ctx);
                notifyTables('create', invoiceId);
                const fresh = await modelsDB.Invoices.findByPk(invoiceId, { raw: true });
                return { invoiceId, number: fresh && fresh.number, name: fresh && fresh.name };
            } catch (e) {
                return { error: (e && e.message) || String(e) };
            }
        },

        // ── RPC: список счетов брони (кнопка/вкладка «Счета» в брони) ─────
        async findInvoicesForBooking({ bookingId }, ctx) {
            if (!bookingId) return { invoices: [] };
            const links = await modelsDB.InvoiceBookings.findAll({ where: { bookingId }, raw: true });
            const ids = [...new Set(links.map(l => l.invoiceId).filter(Boolean))];
            if (!ids.length) return { invoices: [] };
            const invoices = await modelsDB.Invoices.findAll({ where: { UID: ids }, raw: true });
            invoices.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
            return {
                invoices: invoices.map(inv => ({
                    UID: inv.UID, number: inv.number, date: inv.date, status: inv.status, name: inv.name
                }))
            };
        },

        // ── Серверное событие формы: вызывается ДО записи в БД ────────────
        // 1. organizationId в запись и строки ТЧ (паттерн booking).
        // 2. Санитизация числовых полей строк ("" → null).
        // 3. Авторитетный пересчёт amount = quantity * unitPrice построчно.
        async onBeforeSave({ record, changes, tabularSections, parentUID }, ctx) {
            if (!changes.organizationId) {
                try {
                    const globalCtx = require('../../../node_modules/my-old-space/drive_root/globalServerContext');
                    const user = await globalCtx.getUserBySessionID(ctx.sessionID);
                    if (user && user.organizationId) {
                        changes.organizationId = user.organizationId;
                    }
                } catch (e) {
                    console.warn('[invoice/onBeforeSave] Could not resolve user org:', e && e.message);
                }
            }
            let orgId = changes.organizationId;
            if (!orgId) {
                const invId = parentUID || (changes && changes.UID);
                if (invId) {
                    try {
                        const dbRec = await modelsDB.Invoices.findByPk(invId, { raw: true });
                        if (dbRec) orgId = dbRec.organizationId;
                    } catch (_) {}
                }
            }
            if (orgId) {
                for (const rows of Object.values(tabularSections)) {
                    for (const row of rows) {
                        if (!row.organizationId) row.organizationId = orgId;
                    }
                }
            }

            const numFields = ['quantity', 'unitPrice', 'taxRate', 'amount', 'sortOrder'];
            for (const row of (tabularSections.invoice_lines || [])) {
                for (const f of numFields) {
                    if (row[f] === '') row[f] = null;
                }
                // Авторитетный пересчёт суммы (клиентский onChange — только для отклика).
                const qty  = Number(row.quantity);
                const unit = Number(row.unitPrice);
                if (Number.isFinite(qty) && Number.isFinite(unit)) {
                    row.amount = r2(qty * unit);
                }
                if (row.quantity  == null) row.quantity  = 0;
                if (row.unitPrice == null) row.unitPrice = 0;
                if (row.amount    == null) row.amount    = 0;
                if (row.taxRate   == null) row.taxRate   = 0;
                if (row.sortOrder == null) row.sortOrder = 0;
            }
        }

    };
};
