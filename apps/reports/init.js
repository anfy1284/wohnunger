'use strict';

// ─────────────────────────────────────────────────────────────────────
// Приложение «Отчёты» (reports).
// Серверные функции генерации печатных форм.
// Каждый отчёт хранится в своей подпапке: reports/invoice/, reports/...
// ─────────────────────────────────────────────────────────────────────

module.exports = async function (modelsDB) {
    try {
        const { loadServerScript } = require('../../node_modules/my-old-space');
        const { renderInvoiceHTML } = require('./invoice/template');

        // ── Серверный скрипт: отчёты ────────────────────────────────────
        loadServerScript('reports.actions', {

            // Генерация HTML-счёта (Rechnung) по bookingId
            async generateInvoiceHTML({ bookingId } = {}, ctx) {
                if (!bookingId) return { error: 'bookingId обязателен' };

                const booking = await modelsDB.Bookings.findByPk(bookingId, { raw: true });
                if (!booking) return { error: 'Бронирование не найдено' };

                const client = booking.clientId
                    ? await modelsDB.Clients.findByPk(booking.clientId, { raw: true }) : null;
                const hotel = booking.hotelId
                    ? await modelsDB.Hotels.findByPk(booking.hotelId, { raw: true }) : null;
                const org = booking.organizationId
                    ? await modelsDB.Organizations.findByPk(booking.organizationId, { raw: true }) : null;

                const lines = await modelsDB.InvoiceLines.findAll({
                    where: { bookingId },
                    order: [['sortOrder', 'ASC']],
                    raw: true
                });
                if (!lines.length) return { error: 'Нет строк спецификации. Сначала рассчитайте стоимость.' };

                const html = renderInvoiceHTML({ booking, client, hotel, org, lines });
                return { html };
            },

        }, 'user');

        console.log('[reports/init] Report server scripts registered');
    } catch (e) {
        console.error('[reports/init] Failed to register:', e && e.message || e);
    }
};
