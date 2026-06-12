'use strict';

// ─────────────────────────────────────────────────────────────────────
// Приложение «Отчёты» (reports).
// Серверные функции генерации печатных форм.
// Каждый отчёт хранится в своей подпапке: reports/invoice/, reports/...
// ─────────────────────────────────────────────────────────────────────
const { tForSession } = require('../../node_modules/my-old-space/drive_forms/globalServerContext');
const { resolveOrgReportLang } = require('../organizationSettings/lib/orgReportLanguage');

module.exports = async function (modelsDB) {
    try {
        const { loadServerScript } = require('../../node_modules/my-old-space');
        const { renderInvoiceHTML } = require('./invoice/template');

        // ── Серверный скрипт: отчёты ────────────────────────────────────
        loadServerScript('reports.actions', {

            // Генерация HTML-счёта (Rechnung) по bookingId
            async generateInvoiceHTML({ bookingId } = {}, ctx) {
                if (!bookingId) return { error: await tForSession('bookingId required', ctx.sessionID) };

                const booking = await modelsDB.Bookings.findByPk(bookingId, { raw: true });
                if (!booking) return { error: await tForSession('Booking not found', ctx.sessionID) };

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
                if (!lines.length) return { error: await tForSession('No invoice lines. Calculate cost first.', ctx.sessionID) };

                // Язык печати — из настроек организации (organizationSettings → reportLanguage).
                // Значение ссылается на справочник languages; код (de/en/ru/pl) резолвит
                // общий хелпер orgReportLanguage. По умолчанию немецкий. Тот же хелпер
                // использует booking при построении строк счёта — гарантия единого языка.
                const lang = await resolveOrgReportLang(modelsDB, org && org.UID);

                // Примечание в счёте — свободный текст из настроек организации
                // (organizationSettings → invoiceNote). Печатается КАК ЕСТЬ, на том языке,
                // на котором его ввёл пользователь (перевода нет). Пусто → блок не выводится.
                let invoiceNote = '';
                try {
                    if (org && modelsDB.OrganizationSettingsFields) {
                        const noteField = await modelsDB.OrganizationSettingsFields.findOne({ where: { name: 'invoiceNote' }, raw: true });
                        if (noteField) {
                            const rec = await modelsDB.OrganizationSettingsStringValues.findOne({
                                where: { organizationId: org.UID, settingsFieldId: noteField.UID }, raw: true
                            });
                            if (rec && rec.value) invoiceNote = String(rec.value);
                        }
                    }
                } catch (e) { console.warn('[reports] invoiceNote resolve:', e && e.message); }

                const i18n = require('../../node_modules/my-old-space/drive_root/i18n');
                const t = (key) => i18n.t(key, lang);
                const localeMap = { en: 'en-GB', ru: 'ru-RU', pl: 'pl-PL', de: 'de-DE' };
                const locale = localeMap[lang] || 'de-DE';

                const html = renderInvoiceHTML({ booking, client, hotel, org, lines, t, locale, lang, invoiceNote });
                return { html };
            },

        }, 'user');

        console.log('[reports/init] Report server scripts registered');
    } catch (e) {
        console.error('[reports/init] Failed to register:', e && e.message || e);
    }
};
