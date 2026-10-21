'use strict';

// Серверные функции кастомной формы СПИСКА броней (вкладка «Календарь»).
//
// Фабрика: module.exports = (modelsDB, Utilities) => ({ loadCalendar })
// Регистрируется в init.js через loadServerScript('booking.bookingListActions', ...).
// Календарь (UI_classes.Calendar) дёргает loadCalendar напрямую через window.callServer.
//
// Все чтения данных пользователя идут через dbGateway с context.sessionID — RLS
// (organizationId/hotelId/userId) применяется автоматически: пользователь видит
// только свои отели/комнаты/брони. Справочник статусов (booking_statuses) —
// глобальный (excluded_tables), читается напрямую через модель.

const globalRootCtx = require('../../../node_modules/my-old-space/drive_root/globalServerContext');
const dbGateway = require('../../../node_modules/my-old-space/drive_root/dbGateway');
// Пустая дата в проекте — 0001-01-01, а не NULL (drive_root/db/emptyValues.js).
const { isEmptyDate } = require('../../../node_modules/my-old-space/drive_root/db/emptyValues');
const settings = require('../../../node_modules/my-old-space/drive_root/settings');
const state = require('../../../node_modules/my-old-space/drive_root/settings/state');
// Деньги приходят из базы строкой (DECIMAL) и считаются в центах.
const M = require('../../../node_modules/my-old-space/drive_root/db/money');
// Предоплата и остаток услуг по брони — те же модули, что отвечают форме брони:
// один и тот же вопрос, заданный дважды разным кодом, однажды получит два
// разных ответа.
const settlementBalance = require('../../common/lib/settlementBalance');
const bookingServices = require('../../common/lib/bookingServices');

module.exports = function (modelsDB, Utilities) {


    // Натуральная сортировка номеров комнат (учёт цифр внутри строк).
    function byNumber(a, b) {
        return String(a.number || '').localeCompare(String(b.number || ''), undefined, { numeric: true, sensitivity: 'base' });
    }

    // Бронь пересекает окно [from,to], если заезд раньше конца окна, а выезд позже начала.
    // Даты DATEONLY — строки 'YYYY-MM-DD', сравнение лексикографическое корректно.
    function overlaps(b, from, to) {
        return String(b.checkIn) <= String(to) && String(b.checkOut) >= String(from);
    }

    // ── loadCalendar({ hotelId, from, to }, ctx) ───────────────────────────────
    // Возвращает данные шахматки: отели (для селектора), комнаты выбранного отеля,
    // события-полосы (бронь × комната), окно дат, ориентацию из настроек пользователя.
    async function loadCalendar(params, ctx) {
        const sessionID = ctx && ctx.sessionID;
        const ctxDb = { appName: 'uniForm', sessionID };
        const result = { hotels: [], hotelId: null, rooms: [], events: [], from: params && params.from, to: params && params.to, orientation: 'horizontal' };

        try {
            const user = sessionID ? await globalRootCtx.getUserBySessionID(sessionID) : null;
            if (user) {
                // Ориентация шахматки: сначала то, что пользователь выбрал кнопкой в
                // прошлый раз (служебная настройка), иначе настройка из формы настроек.
                // Порядок именно такой: кнопка — последнее явное действие пользователя,
                // а настройка это то, с чего начинает тот, кто её ни разу не нажимал.
                const remembered = await state.get(user.UID, 'booking', 'calendarOrientation');
                const ori = (remembered === 'horizontal' || remembered === 'vertical')
                    ? remembered
                    : await settings.getUserSetting(user.UID, 'booking', 'calendarOrientation');
                if (ori === 'horizontal' || ori === 'vertical') result.orientation = ori;
            }

            // Доступные отели (RLS) — для селектора.
            const hotels = await dbGateway.execute({ operation: 'read', table: 'hotels', where: {}, options: { raw: true }, context: ctxDb }) || [];
            result.hotels = hotels.map(h => ({ UID: h.UID, name: h.name })).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

            const hotelId = (params && params.hotelId) || (result.hotels[0] && result.hotels[0].UID) || null;
            result.hotelId = hotelId;
            if (!hotelId) return result;

            // Комнаты выбранного отеля (RLS), сортировка по номеру.
            const rooms = await dbGateway.execute({ operation: 'read', table: 'rooms', where: { hotelId }, options: { raw: true }, context: ctxDb }) || [];
            // Подпись строки календаря — название номера («Doppelzimmer 1»), порядок — по номеру.
            const roomList = rooms.map(r => ({ UID: r.UID, number: r.number, name: r.name })).sort(byNumber);
            result.rooms = roomList;
            const roomSet = new Set(roomList.map(r => r.UID));
            if (!roomList.length) return result;

            // Брони отеля (RLS), фильтр пересечения с окном.
            const from = result.from, to = result.to;
            const allBookings = await dbGateway.execute({ operation: 'read', table: 'bookings', where: { hotelId }, options: { raw: true }, context: ctxDb }) || [];
            // Даты проверяются через isEmptyDate: пустая дата в проекте —
            // 0001-01-01, а не NULL, поэтому `b.checkIn &&` пропустило бы
            // бронь без дат в шахматку.
            const bookings = allBookings.filter(b => !isEmptyDate(b.checkIn) && !isEmptyDate(b.checkOut) && overlaps(b, from, to));
            if (!bookings.length) return result;

            const bookingIds = bookings.map(b => b.UID);

            // Привязки бронь→комната (RLS).
            const bookingRooms = await dbGateway.execute({ operation: 'read', table: 'booking_rooms', where: { bookingId: bookingIds }, options: { raw: true }, context: ctxDb }) || [];

            // Имена клиентов.
            const clientIds = [...new Set(bookings.map(b => b.clientId).filter(Boolean))];
            const clients = clientIds.length
                ? (await dbGateway.execute({ operation: 'read', table: 'clients', where: { UID: clientIds }, options: { raw: true }, context: ctxDb }) || [])
                : [];
            const clientName = {};
            clients.forEach(c => { clientName[c.UID] = c.name; });

            // Цвета статусов (глобальный справочник).
            const statusColor = {};
            try {
                const statuses = await modelsDB.BookingStatuses.findAll({ raw: true });
                statuses.forEach(s => { statusColor[s.UID] = s.color; });
            } catch (e) { /* без цветов — полоса будет дефолтной */ }

            const bookingById = {};
            bookings.forEach(b => { bookingById[b.UID] = b; });

            // События: одна полоса на (бронь × назначенная комната этого отеля).
            const events = [];
            for (const br of bookingRooms) {
                if (!roomSet.has(br.roomId)) continue; // комната не из этого отеля — пропуск
                const b = bookingById[br.bookingId];
                if (!b) continue;
                events.push({
                    UID: b.UID,
                    resourceId: br.roomId,
                    start: b.checkIn,
                    end: b.checkOut,
                    label: clientName[b.clientId] || b.number || '',
                    color: statusColor[b.statusId] || null,
                    raw: b
                });
            }
            result.events = events;
            return result;
        } catch (e) {
            console.error('[booking/loadCalendar] error:', e && e.message || e);
            return result;
        }
    }

    /**
     * ВЫЧИСЛЯЕМЫЕ РЕКВИЗИТЫ ЖУРНАЛА БРОНЕЙ (`entityConfig.listAttributes`).
     *
     * Метод ядра: зовётся один раз на страницу строк журнала и отвечает
     * `{ UID: { реквизит: значение } }`. Запрос НА СТРОКУ здесь недопустим —
     * журнал открывает сотню строк (ТЗ «Учёт услуг по брони», §9).
     *
     * `prepaymentPaid` — СКОЛЬКО ВНЕСЕНО по броне: движения регистра расчётов от
     * денежных документов, без зачёта счётом (21.10.2026: «0» после счёта читался
     * как «не платили»). Поля такого в таблице нет и быть не должно: предоплата ЕСТЬ
     * сумма проведённых денежных документов, а хранимое поле рядом разошлось бы с
     * ними на первом же исправленном платеже (раздел 77 архитектуры). Спрашиваем
     * ОДНИМ запросом — `settlementBalance.paidOfBookings`, тот же модуль и тот же
     * вопрос, что у поля «Anzahlung» на форме брони.
     *
     * `overInvoiced` — сумма, на которую ВЫСТАВЛЕНО БОЛЬШЕ, чем заказано
     * (ТЗ §8): гость уехал раньше, бронь урезали после выставления счёта. Это и
     * есть автоматическое обнаружение случая § 17 Abs. 1 UStG, который сегодня
     * никто не замечает. Признак — отрицательный остаток регистра услуг, а не
     * сравнение дат: причина расхождения может быть любой, а признак один.
     *
     * Строкам БЕЗ расхождения отдаётся `null`, а не нуль: пустая ячейка — это
     * «нечего смотреть», а «0,00» в каждой строке журнала читается как данные и
     * через день перестаёт читаться вовсе. На том же `null` держится и красный
     * тон строки (`rowTones`, правило `notIn: [""]`).
     */
    async function onLoadListAttributes({ ids }, ctx) {
        const out = {};
        const bookingIds = (ids || []).filter(Boolean);
        if (!bookingIds.length) return out;
        const sessionID = ctx && ctx.sessionID;

        // Предоплата — одним запросом на все брони страницы.
        let byBooking = {};
        try {
            const res = await settlementBalance.paidOfBookings({ bookingIds, sessionID });
            byBooking = (res && res.byBooking) || {};
        } catch (e) {
            console.error('[booking/onLoadListAttributes] предоплата не посчитана:', e && e.message || e);
        }

        // Расхождение «выставлено больше, чем заказано» — тоже одним запросом:
        // остаток регистра услуг по всем броням страницы, в разрезе позиций.
        const over = {};
        try {
            const remaining = await bookingServices.remaining({ bookingIds, sessionID });
            for (const row of remaining.values()) {
                over[row.bookingId] = M.add(over[row.bookingId] || 0,
                    bookingServices.overInvoicedAmount(row));
            }
            for (const id of Object.keys(over)) if (M.isZero(over[id])) delete over[id];
        } catch (e) {
            console.error('[booking/onLoadListAttributes] расхождение не посчитано:', e && e.message || e);
        }

        for (const id of bookingIds) {
            out[id] = {
                prepaymentPaid: byBooking[id] != null ? byBooking[id] : M.db(0),
                overInvoiced: over[id] ? M.db(over[id]) : null
            };
        }
        return out;
    }

    return { loadCalendar, onLoadListAttributes };
};
