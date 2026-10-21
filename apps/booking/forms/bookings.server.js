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
// Пустая дата в проекте — 0001-01-01, а не NULL (drive_root/db/emptyValues.js).
const { isEmptyDate } = require('../../../node_modules/my-old-space/drive_root/db/emptyValues');
// Деньги приходят из базы строкой (DECIMAL) и считаются в центах.
const M = require('../../../node_modules/my-old-space/drive_root/db/money');
// Предоплата брони — остаток регистра расчётов, а не хранимое поле. Вопрос один
// и тот же у формы брони и у счёта, поэтому и место ответа одно.
const settlementBalance = require('../../common/lib/settlementBalance');
// Чем заполнить денежный документ по брони — одно правило с проведением аванса.
const paymentDocument = require('../lib/paymentDocument');

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
            // Услуга ещё не выбрана (строка только что добавлена «+»): судить о
            // формуле не по чему. Раньше здесь снималась галочка 🔄, и выбранная
            // следом услуга с `@nights` оставалась с количеством 1 (прогон 17.10.2026, D1).
            if (!row.serviceId) continue;
            const formula = formulaById[row.serviceId] || '';
            if (!formula) { row.autoQuantity = false; continue; } // пустая формула → снять галочку
            let q = null;
            try { q = formulaEngine.evaluate(formula, values); } catch (_) { q = null; }
            if (q == null || !isFinite(q)) continue;            // некорректная формула — count не меняем
            row.count = Math.max(0, Math.round(q));
        }
        return rows;
    }

    // ПОМЕТКА «ВЫСТАВЛЕНО БОЛЬШЕ, ЧЕМ ЗАКАЗАНО» переехала из этой формы в
    // механизм ядра (02.10.2026): теперь это ПРАВИЛО ОПОВЕЩЕНИЯ
    // `booking.overInvoiced` (`apps/booking/alerts.rules.js`,
    // `hooks/alerts.js`), и показывает его панель оповещений, которую ядро
    // рисует на любой форме документа.
    //
    // Что от этого выиграли, кроме снятия заплатки с одной формы: у пометки
    // появилось ДЕЙСТВИЕ («Открыть счёт» — корректировку выпускает счёт, а не
    // бронь), она видна значком в журнале и в обработке «Проверка документов»,
    // по ней уходит уведомление ОДИН раз, и она исчезает сама, когда
    // корректировка выпущена. Текст при этом тот же (`over_invoiced_notice`) —
    // второй формулировки одной беды не завелось.

    return {

        /**
         * ВЫЧИСЛЯЕМЫЕ РЕКВИЗИТЫ ФОРМЫ брони.
         *
         * `prepaymentPaid` — «Anzahlung» существующей брони: СКОЛЬКО ВСЕГО ВНЕСЕНО
         * (поступления минус возвраты по этой брони), а не незачтённый остаток.
         * После выставления счёта там та же сумма, а не 0: «0» в поле «Anzahlung»
         * читался как «не платили» (ТЗ платежей брони, решение 3). Хранить величину
         * рядом значило бы завести второй источник, который разошёлся бы с
         * денежными документами на первом же исправленном платеже.
         *
         * `firstPrepaymentOpen` — можно ли ещё ввести ПЕРВЫЙ аванс прямо в брони
         * (поля «Anzahlung»/«Zahlungsart»). Да — у новой брони и у той, чей аванс
         * ещё не стал документом: введён (сумма не 0), штампа нет, бронь не
         * проведена (например, первое проведение не удалось — поля остаются, их
         * можно поправить). Решает сервер: штамп — служебное поле, на форму оно не
         * приходит. Брони, сохранённой БЕЗ аванса, поля больше не показываются —
         * иначе аванс, введённый через месяц, получил бы дату создания брони (дата
         * поступления — момент ввода, § 146 Abs. 1 Satz 2 AO); для него есть
         * вкладка «Zahlungen».
         */
        async onLoadAttributes({ recordID, isNew, record }, ctx) {
            if (isNew || !recordID) return { prepaymentPaid: 0, firstPrepaymentOpen: true };
            const sessionID = ctx && ctx.sessionID;
            const r = record || {};
            const stamp = r.firstPrepaymentReceiptId;
            const open = !M.isZero(M.num(r.firstPrepaymentAmount))
                && (stamp === null || stamp === undefined || String(stamp) === '')
                && r.postingState !== 'posted';
            return {
                prepaymentPaid: await settlementBalance.paidOfBooking({
                    bookingId: recordID, sessionID
                }),
                firstPrepaymentOpen: open
            };
        },

        /**
         * ЧЕМ ЗАПОЛНИТЬ ДЕНЕЖНЫЙ ДОКУМЕНТ, добавленный с вкладки «Zahlungen».
         *
         * Метод формы-владельца подчинённого журнала (`properties.owner.fill`):
         * ядро зовёт его при «Добавить» с `{ docTable, recordID }` и кладёт ответ в
         * `prefill` НЕСОХРАНЁННОЙ формы — передумал и закрыл, в базе ничего нет.
         * Касса не знает про бронь; бронь говорит сама, что у её платежа заполнить:
         * организация, отель, клиент, бронь, вид операции (аванс — для поступления,
         * возврат аванса — для выплаты), способ оплаты из личной настройки и место
         * хранения под этот способ. Сумму не подставляем: угадать её за человека —
         * ровно та ошибка, что стоит денег.
         */
        async fillPaymentDocument({ docTable, recordID }, ctx) {
            const sessionID = ctx && ctx.sessionID;
            const dbGateway = require('../../../node_modules/my-old-space/drive_root/dbGateway');
            const rows = await dbGateway.execute({
                operation: 'read', table: 'bookings', where: { UID: recordID },
                options: { raw: true, limit: 1 },
                context: { appName: 'booking', sessionID }
            });
            const booking = Array.isArray(rows) && rows[0];
            if (!booking) return { error: await tForSession('booking_not_found_for_payment', sessionID) };

            const code = paymentDocument.OPERATION_CODE[docTable];
            if (!code) return { error: await tForSession('booking_payment_kind_not_allowed', sessionID) };

            const prefill = {
                organizationId: booking.organizationId,
                hotelId: booking.hotelId || null,
                clientId: booking.clientId || null,
                bookingId: booking.UID
            };
            const opType = await paymentDocument.findOperationType({
                code, organizationId: booking.organizationId, sessionID
            });
            if (opType) prefill.operationTypeId = opType.UID;

            let method = null;
            try {
                const settings = require('../../../node_modules/my-old-space/drive_root/settings');
                method = ctx && ctx.user ? await settings.getUserSetting(ctx.user.UID, 'cash', 'defaultPaymentMethod') : null;
            } catch (e) { /* без настройки — умолчание поля документа */ }
            if (method) {
                prefill.paymentMethod = method;
                const place = await paymentDocument.placeFor({
                    organizationId: booking.organizationId, method, sessionID
                });
                if (place) prefill.cashboxId = place.UID;
            }
            return { prefill };
        },

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
                // Пустая дата — 0001-01-01, а не NULL: проверять через
                // isEmptyDate, иначе сравнение уйдёт на незаполненных датах.
                if (!isEmptyDate(eff.checkIn) && !isEmptyDate(eff.checkOut)) {
                    const ci = new Date(eff.checkIn), co = new Date(eff.checkOut);
                    if (!isNaN(ci.getTime()) && !isNaN(co.getTime()) && co <= ci) {
                        throw new Error(await tForSession('checkout_after_checkin', ctx.sessionID));
                    }
                    // ДЛИТЕЛЬНАЯ СДАЧА (> 6 месяцев по договору — § 4 Nr. 12 Satz 1
                    // Buchst. a UStG, db.json `//longTermLetting`). Признак ставится по
                    // датам, когда даты ВВОДЯТ или МЕНЯЮТ: это и есть момент договорённости.
                    // Ручная правка признака в том же сохранении сильнее; при сохранении
                    // без смены дат признак не трогаем — человек мог исправить его сам.
                    const datesTouched = !dbRec || ('checkIn' in (changes || {})) || ('checkOut' in (changes || {}));
                    const userTouched = dbRec && ('longTermLetting' in (changes || {}))
                        && !!changes.longTermLetting !== !!dbRec.longTermLetting;
                    if (datesTouched && !userTouched && !isNaN(ci.getTime()) && !isNaN(co.getTime())) {
                        const limit = new Date(ci.getTime());
                        limit.setMonth(limit.getMonth() + 6);
                        const isLong = co > limit;
                        changes.longTermLetting = (!dbRec && changes.longTermLetting === true) || isLong;
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
                const dv = M.num(changes.discountValue);
                changes.discountValue = Number.isFinite(dv) ? Math.max(0, dv) : 0;
            }
            if ('discountMode' in changes && !changes.discountMode) changes.discountMode = 'percent';

            // 0.5. Контроля «нет цены номера» ЗДЕСЬ БОЛЬШЕ НЕТ (16.10.2026). Он
            //    блокировал сохранение; владелец: «предупреждать, чтобы можно было
            //    сначала сохранить, а потом идти разбираться в прайсы». Теперь это
            //    пометка брони `booking.missingPrices` (hooks/alerts.js) — висит,
            //    пока цены нет, и уходит сама. Заодно ушёл зашитый в код порог
            //    «оплачиваемые гости — от 6 лет»: кто входит в тариф номера, решает
            //    справочник (`guest_types.roomRateMode`), а расчёт уже знает это.

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
            let defaults = await modelsDB.HotelDefaultServices.findAll({
                where: { hotelId }, order: [['displayOrder', 'ASC']], raw: true
            });
            // Набор отеля не задан — услуги с флажком «Standardmäßig einbeziehen»
            // (16.10.2026). Набор `hotel_default_services` сотруднику заполнить негде,
            // и в новой организации номер приходил без единой услуги, хотя флажок у
            // завтрака стоял (прогон сценариев D1.3). Услуга этого отеля или без отеля.
            if (!defaults.length) {
                const hotel = await modelsDB.Hotels.findByPk(hotelId, { raw: true });
                if (hotel) {
                    const { Op } = require('sequelize');
                    const flagged = await modelsDB.Services.findAll({
                        where: {
                            organizationId: hotel.organizationId,
                            includeByDefault: true,
                            deletionMark: false,
                            [Op.or]: [{ hotelId }, { hotelId: null }, { hotelId: '' }]
                        },
                        order: [['displayOrder', 'ASC'], ['name', 'ASC']], raw: true
                    });
                    defaults = flagged.map(s => ({ serviceId: s.UID }));
                }
            }
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
        // Читает настройку `common.defaultTaxRate` (уровень организации) для организации
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
                if (!orgId) return { taxRateId: null, taxRateName: '' };

                const settings = require('../../../node_modules/my-old-space/drive_root/settings');
                const taxRateId = await settings.getRecordSetting('organization', orgId, 'common', 'defaultTaxRate');
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