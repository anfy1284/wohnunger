'use strict';

// Серверные функции формы "Бронирование".
//
// Экспортирует фабрику: module.exports = function(modelsDB, Utilities) { return { ... }; }
// Вызывается из init.js: loadServerScript('booking.bookingActions', require('./bookings.server')(modelsDB, Utilities), 'user')
//
// Каждая функция получает (params, ctx) где ctx = { sessionID, user, role }.

// Расчёт строк счёта (_buildInvoiceLines) переехал в apps/invoice/forms/invoices.server.js:
// счёт — самостоятельный документ, бронь его строки больше не строит и не печатает.

const { tForSession, tfForSession } = require('../../../node_modules/my-old-space/drive_forms/globalServerContext');
const formulaEngine = require('../../common/lib/formulaEngine');

module.exports = function (modelsDB, Utilities) {

    // Цены проживания — ТОЛЬКО через резолвер прайс-листов («срез последних»
    // по позиции на дату ценообразования): контроль заполняемости в onBeforeSave.
    const priceResolver = require('../../common/lib/priceResolver')(modelsDB);

    // ── Пересчёт количеств услуг по формуле (services.quantityFormula) ───────
    // Единый источник: использует общий движок formulaEngine (парсер + реестр
    // переменных). Применяется и при сохранении (onBeforeSave, авторитетно), и
    // по событию изменения формы (RPC recalcServiceQuantities, live).
    //
    // Правила (autoQuantity — флаг строки ТЧ booking_room_services):
    //   • autoQuantity === false → строку не трогаем (пользователь ввёл вручную).
    //   • autoQuantity !== false  → если формула услуги пустая, снимаем флаг
    //     (autoQuantity=false) и количество НЕ меняем; иначе count = round(формула).
    // Мутирует переданные строки на месте и возвращает их же.
    async function _recalcServiceQuantities(rows, dateCtx) {
        if (!Array.isArray(rows) || !rows.length) return rows;
        const serviceIds = [...new Set(rows.map(r => r && r.serviceId).filter(Boolean))];
        const svcRecs = serviceIds.length
            ? await modelsDB.Services.findAll({ where: { UID: serviceIds }, raw: true }) : [];
        const formulaById = {};
        for (const s of svcRecs) formulaById[s.UID] = (s.quantityFormula || '').trim();

        const values = formulaEngine.resolveVariables({
            checkIn:  dateCtx && dateCtx.checkIn,
            checkOut: dateCtx && dateCtx.checkOut
        });

        for (const row of rows) {
            if (!row) continue;
            if (row.autoQuantity === false) continue;          // ручное значение — не трогаем
            const formula = row.serviceId ? formulaById[row.serviceId] : '';
            if (!formula) { row.autoQuantity = false; continue; } // пустая формула → снять галочку
            let q = null;
            try { q = formulaEngine.evaluate(formula, values); } catch (_) { q = null; }
            if (q == null || !isFinite(q)) continue;            // некорректная формула — count не меняем
            row.count = Math.max(0, Math.round(q));
        }
        return rows;
    }

    return {

        // ── Серверное событие формы ──────────────────────────────────────
        // Вызывается ДО записи в БД.
        // 1. Заполняем organizationId в основной записи и во все строки ТЧ.
        // 2. Держим ТЧ консистентными и пересчитываем количества услуг по формуле.
        // Строки счёта бронь НЕ строит (см. apps/invoice).
        async onBeforeSave({ record, changes, tabularSections, parentUID }, ctx) {
            // 0. Контроль дат: дата выезда должна быть строго больше даты заезда.
            //    changes содержит только изменённые поля — дочитываем запись из БД и мерджим,
            //    чтобы проверить актуальную пару дат (могла измениться только одна из них).
            //    Бросаем ошибку → dispatchServerEvent пробросит её, applyChanges вернёт
            //    { ok:false, error } и клиент покажет сообщение, сохранение не произойдёт.
            {
                const bId = parentUID || (changes && changes.UID);
                let dbRec = null;
                if (bId) {
                    try { dbRec = await modelsDB.Bookings.findByPk(bId, { raw: true }); } catch (_) {}
                }
                const eff = Object.assign({}, dbRec || {}, changes || {});
                if (eff.checkIn && eff.checkOut) {
                    const ci = new Date(eff.checkIn), co = new Date(eff.checkOut);
                    if (!isNaN(ci.getTime()) && !isNaN(co.getTime()) && co <= ci) {
                        throw new Error(await tForSession('checkout_after_checkin', ctx.sessionID));
                    }
                }
            }

            // 1. organizationId (до контроля заполняемости — резолверу цен нужна организация)
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

            // Скидка брони (переносится в счёт): пустое/нечисло → 0, отрицательное → 0.
            if ('discountValue' in changes) {
                const dv = Number(changes.discountValue);
                changes.discountValue = Number.isFinite(dv) ? Math.max(0, dv) : 0;
            }
            if ('discountMode' in changes && !changes.discountMode) changes.discountMode = 'percent';

            // 0.5. Контроль заполняемости: для каждого номера в срезе прайс-листов
            //    должен существовать тариф проживания под текущее число «оплачиваемых»
            //    гостей (6+) на дату заезда. Дата ценообразования здесь — ВСЕГДА дата
            //    документа брони (на момент проверки счёта ещё нет). Если тарифа нет
            //    (занятость превышает прайс-лист номера) — бронь некорректна: молча
            //    терять строку проживания нельзя, поэтому БЛОКИРУЕМ сохранение с понятным
            //    сообщением (на языке пользователя). Это не внутри try/catch ниже
            //    (он глушит ошибки) — иначе блокировка бы не сработала.
            {
                const rooms = (tabularSections.booking_rooms || []).filter(r => r && r.UID);
                const guests = tabularSections.booking_guests || [];
                const bId2 = parentUID || (changes && changes.UID);
                let dbRec2 = null;
                if (bId2) { try { dbRec2 = await modelsDB.Bookings.findByPk(bId2, { raw: true }); } catch (_) {} }
                const eff2 = Object.assign({}, dbRec2 || {}, changes || {});
                const ciVal = eff2.checkIn;
                if (rooms.length && ciVal && eff2.organizationId) {
                    const ci = new Date(ciVal);
                    const roomIds = [...new Set(rooms.map(r => r.roomId).filter(Boolean))];
                    const gtRecs = await modelsDB.GuestTypes.findAll({ raw: true });
                    const gtAge = {};
                    for (const g of gtRecs) gtAge[g.UID] = g.ageFrom;
                    // Новая бронь ещё не имеет даты документа (хук default.documentDate
                    // сработает при записи) — берём текущий момент, как поставит хук.
                    const slice = await priceResolver.loadSlice({
                        organizationId: eff2.organizationId,
                        hotelId:        eff2.hotelId,
                        pricingDate:    eff2.date || new Date()
                    });
                    const rRecs = roomIds.length
                        ? await modelsDB.Rooms.findAll({ where: { UID: roomIds }, raw: true }) : [];
                    const rNum = {};
                    for (const r of rRecs) rNum[r.UID] = r.number;

                    for (const room of rooms) {
                        let billingGuests = 0;
                        for (const g of guests) {
                            if (g.bookingRoomId !== room.UID) continue;
                            if (gtAge[g.guestTypeId] >= 6) billingGuests += (g.count || 1);
                        }
                        if (billingGuests <= 0) continue;   // нет оплачиваемых гостей — отдельный случай, не блокируем
                        const has = priceResolver.pickRoomPrice(slice, {
                            roomId: room.roomId, guestsCount: billingGuests, stayDate: ci
                        });
                        if (!has) {
                            throw new Error(await tfForSession('no_room_price_for_occupancy', ctx.sessionID, {
                                room: rNum[room.roomId] || room.roomId, guests: billingGuests
                            }));
                        }
                    }
                }
            }

            // 2. Консистентность ТЧ + пересчёт количеств услуг (до записи в БД).
            //    Строки СЧЁТА бронь больше НЕ строит: счёт — самостоятельный документ
            //    (apps/invoice), его строки создаёт fillInvoice/createFromBooking.
            //    Сохранение брони выписанные счета не трогает.
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

                // Пересчёт количеств услуг по формуле (авторитетно).
                try { await _recalcServiceQuantities(tabularSections.booking_room_services, { checkIn, checkOut }); } catch (e) {
                    console.warn('[booking/onBeforeSave] quantity recalc failed:', e && e.message);
                }
            } catch (e) {
                console.error('[booking/onBeforeSave] TS consistency pass failed:', e && e.message || e);
            }
        },

        // ── Live-пересчёт количеств услуг по формуле (вызывается по событию
        //    изменения формы). Принимает текущие строки ТЧ услуг + даты брони,
        //    возвращает обновлённые { UID, count, autoQuantity } для применения на форме.
        async recalcServiceQuantities({ checkIn, checkOut, roomServices }, ctx) {
            const rows = Array.isArray(roomServices) ? roomServices.map(r => ({
                UID:          r && r.UID,
                serviceId:    r && r.serviceId,
                autoQuantity: !(r && r.autoQuantity === false),
                count:        r && r.count
            })) : [];
            await _recalcServiceQuantities(rows, { checkIn, checkOut });
            return { rows: rows.map(r => ({ UID: r.UID, count: r.count, autoQuantity: r.autoQuantity })) };
        },

        // ── Возвращает дефолтные услуги для отеля (для переформирования ТЧ услуг
        //    при выборе номера). Для каждой услуги возвращает флаг includeByDefault —
        //    им заполняется реквизит "включено" строки ТЧ.
        //    force=true — пропустить проверку «услуги уже есть в БД» (нужно при
        //    переформировании по выбору комнаты: всегда отдаём актуальный набор).
        async getDefaultServices({ hotelId, bookingRoomId, force }, ctx) {
            if (!hotelId) return { services: [] };
            // Если для этого номера услуги уже есть в БД — не добавляем повторно
            // (кроме явного переформирования force=true).
            if (bookingRoomId && !force) {
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
                    serviceName: (svcMap2[d.serviceId] && svcMap2[d.serviceId].name) || '',
                    includeByDefault: !!(svcMap2[d.serviceId] && svcMap2[d.serviceId].includeByDefault),
                    hasFormula: !!(svcMap2[d.serviceId] && (svcMap2[d.serviceId].quantityFormula || '').trim())
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