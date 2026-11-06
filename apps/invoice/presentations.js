'use strict';

/**
 * Представление (поле `name`) документа «Счёт»: номер + клиент + дата.
 *
 * ФАЙЛ ГРУЗЯТ ДВА ПРОЦЕССА — главный и форкнутый воркер планировщика, потому что
 * представление счёта пересобирается не только при сохранении формы. С 05.11.2026
 * организация может отложить выдачу номера до проведения
 * (`core.numberOnPost`, drive_root/db/numbering.js), а проведение исполняет воркер,
 * где `init.js` не выполнялся: билдер, зарегистрированный там, в воркере не
 * существует, и счёт остался бы с представлением без номера. Отсюда чистая
 * фабрика без побочных эффектов (как apps/cash/presentations.js).
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
    if (!v) return null;
    const dt = new Date(v);
    if (isNaN(dt.getTime())) return null;
    const p = n => String(n).padStart(2, '0');
    return `${p(dt.getDate())}.${p(dt.getMonth() + 1)}.${dt.getFullYear()}`;
}

module.exports = function () {
    return {
        invoices: async (data, ctx) => {
            const parts = [];
            if (data.number) parts.push(String(data.number));
            const client = await clientName(data, ctx);
            if (client) parts.push(client);
            const d = ddmmyyyy(data.date);
            if (d) parts.push(d);
            return parts.join(' ');
        }
    };
};
