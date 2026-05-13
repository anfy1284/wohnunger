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

async function onBeforeCreate(request, params, context) {
    // TODO: добавить логику перед созданием брони
}

module.exports = { onBeforeCreate };
