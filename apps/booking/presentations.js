'use strict';

/**
 * Представление (поле `name`) документа «Бронирование»: номер + клиент + даты
 * заезда–выезда.
 *
 * ФАЙЛ ГРУЗЯТ ДВА ПРОЦЕССА — главный и форкнутый воркер планировщика. Бронь
 * проводится в режиме `onSave`, то есть её представление пересобирается и в
 * воркере: с 05.11.2026 организация может отложить выдачу номера до проведения
 * (`core.numberOnPost`, drive_root/db/numbering.js), а билдер, зарегистрированный
 * в `init.js`, воркеру недоступен — бронь осталась бы с представлением без
 * номера. Отсюда чистая фабрика без побочных эффектов.
 */

async function clientName(data, ctx) {
    if (!data.clientId || !ctx || !ctx.modelsDB) return null;
    const Clients = ctx.modelsDB.Clients
        || Object.values(ctx.modelsDB).find(m => m && m.tableName === 'clients');
    if (!Clients) return null;
    try {
        const c = await Clients.findByPk(data.clientId, { raw: true });
        return (c && c.name) || null;
    } catch (e) {
        return null;   // без имени клиента
    }
}

function ddmmyyyy(v) {
    if (!v) return '';
    const dt = new Date(v);
    if (isNaN(dt.getTime())) return String(v);
    const p = n => String(n).padStart(2, '0');
    return `${p(dt.getDate())}.${p(dt.getMonth() + 1)}.${dt.getFullYear()}`;
}

module.exports = function () {
    return {
        bookings: async (data, ctx) => {
            const parts = [];
            if (data.number) parts.push(String(data.number));
            const client = await clientName(data, ctx);
            if (client) parts.push(client);
            const ci = ddmmyyyy(data.checkIn), co = ddmmyyyy(data.checkOut);
            if (ci || co) parts.push(`${ci}–${co}`);
            return parts.join(' ');
        }
    };
};
