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
                // Ориентация шахматки — настройка `booking.calendarOrientation`
                // (общий механизм настроек, drive_root/settings).
                const ori = await settings.getUserSetting(user.UID, 'booking', 'calendarOrientation');
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
            const roomList = rooms.map(r => ({ UID: r.UID, number: r.number })).sort(byNumber);
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

    return { loadCalendar };
};
