'use strict';

/**
 * Представление (поле `name`) документа «Прайс-лист»: номер + отель + дата.
 *
 * ФАЙЛ ГРУЗЯТ ДВА ПРОЦЕССА — главный и форкнутый воркер планировщика: с
 * 05.11.2026 организация может отложить выдачу номера до проведения
 * (`core.numberOnPost`, drive_root/db/numbering.js), а проведение исполняет
 * воркер, где `init.js` не выполнялся. Отсюда чистая фабрика без побочных
 * эффектов (как apps/cash/presentations.js).
 */

module.exports = function () {
    return {
        price_lists: async (data, ctx) => {
            const parts = [];
            if (data.number) parts.push(String(data.number));

            if (data.hotelId && ctx && ctx.modelsDB) {
                const Hotels = ctx.modelsDB.Hotels
                    || Object.values(ctx.modelsDB).find(m => m && m.tableName === 'hotels');
                if (Hotels) {
                    try {
                        const h = await Hotels.findByPk(data.hotelId, { raw: true });
                        if (h && h.name) parts.push(h.name);
                    } catch (e) { /* без имени отеля */ }
                }
            }

            if (data.date) {
                const dt = new Date(data.date);
                if (!isNaN(dt.getTime())) {
                    const p = n => String(n).padStart(2, '0');
                    parts.push(`${p(dt.getDate())}.${p(dt.getMonth() + 1)}.${dt.getFullYear()}`);
                }
            }

            return parts.join(' ');
        }
    };
};
