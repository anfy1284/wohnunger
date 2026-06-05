'use strict';

/**
 * Пользовательские хуки для таблицы bookings.
 *
 * Регистрация в init.js:
 *   entityHooks.register('booking.onBeforeCreate', require('./hooks/bookingHooks').onBeforeCreate);
 *
 * Сигнатура: async (request, params, context)
 *   request.data   — данные новой записи (можно мутировать)
 *   request.table  — 'bookings'
 *   params         — params из entityConfig (или {})
 *   context        — { modelsDB, dbGateway }
 */

// UID статуса «Черновик» из apps/common/db/defaultValues.json (booking_statuses)
const DEFAULT_STATUS_UID = '000000000-bk-status-0001';

async function onBeforeCreate(request, params, context) {
    // Статус по умолчанию — «Черновик», если пользователь не выбрал другой.
    // statusId — NOT NULL FK на booking_statuses, поэтому пустое значение
    // (null/"") заменяем на UID черновика до вставки в БД.
    if (request.data && !request.data.statusId) {
        request.data.statusId = DEFAULT_STATUS_UID;
    }
}

module.exports = { onBeforeCreate };
