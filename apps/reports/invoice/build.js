'use strict';

// Сборка печатной формы счёта: данные → HTML.
//
// Вынесено из `apps/reports/init.js`, потому что зовут это ДВОЕ:
//   1. RPC `reports.generateInvoiceHTML` — печать по кнопке;
//   2. команда «Выставить» (`apps/invoice`) — снимок в архив.
// Второй обязан получить ровно тот же HTML, что увидит пользователь: архив
// хранит выданный документ, а не его пересборку.
//
// `draft: true` добавляет водяной знак «Entwurf» — распечатанный черновик
// обязан быть отличим от счёта.

const { renderInvoiceHTML } = require('./template');
const { resolveOrgReportLang } = require('../../organizationSettings/lib/orgReportLanguage');

/**
 * @param {Object} modelsDB
 * @param {string} invoiceId
 * @param {Object} [opts]
 * @param {boolean} [opts.draft] — печатать с пометкой «черновик»
 * @returns {Promise<{html: string, payload: Object, invoice: Object, org: Object, client: Object, lines: Array, lang: string}>}
 */
async function buildInvoiceDoc(modelsDB, invoiceId, opts = {}) {
    const draft = !!opts.draft;

            if (!invoiceId) throw new Error('invoiceId required');

            const invoice = await modelsDB.Invoices.findByPk(invoiceId, { raw: true });
            if (!invoice) throw new Error('Invoice not found');

            const client = invoice.clientId
                ? await modelsDB.Clients.findByPk(invoice.clientId, { raw: true }) : null;
            const hotel = invoice.hotelId
                ? await modelsDB.Hotels.findByPk(invoice.hotelId, { raw: true }) : null;
            const org = invoice.organizationId
                ? await modelsDB.Organizations.findByPk(invoice.organizationId, { raw: true }) : null;

            const lines = await modelsDB.InvoiceLines.findAll({
                where: { invoiceId },
                order: [['sortOrder', 'ASC']],
                raw: true
            });
            if (!lines.length) throw new Error('No invoice lines. Fill the invoice first.');

            // Брони счёта (в порядке добавления в ТЧ) — для дат проживания в шапке
            // и посекционной печати при нескольких бронях.
            const links = await modelsDB.InvoiceBookings.findAll({
                where: { invoiceId }, order: [['createdAt', 'ASC']], raw: true
            });
            const bookingIds = [...new Set(links.map(l => l.bookingId).filter(Boolean))];
            const bookings = [];
            for (const bId of bookingIds) {
                const b = await modelsDB.Bookings.findByPk(bId, { raw: true });
                if (b) bookings.push(b);
            }

            // Язык печати — из настроек организации (organizationSettings → reportLanguage).
            // Тот же хелпер использует fillInvoice при построении строк — единый язык.
            const lang = await resolveOrgReportLang(modelsDB, org && org.UID);

            // Основания ставок НДС (§ 14 Abs. 4 Nr. 8 UStG) — ДАННЫЕ справочника
            // tax_categories.invoiceNote, а не текст в шаблоне: одна ставка 0%
            // может значить «durchlaufender Posten» (§ 10 Abs. 1 S. 4) или
            // освобождение (§ 4 Nr. 12a). Строка счёта хранит снапшот категории.
            // Перевод — на язык ДОКУМЕНТА (не сессии), поэтому lookup берём явно.
            const taxCategories = {};
            try {
                const catIds = [...new Set(lines.map(l => l.taxCategoryId).filter(Boolean))];
                if (catIds.length && modelsDB.TaxCategories) {
                    const cats = await modelsDB.TaxCategories.findAll({ where: { UID: catIds }, raw: true });
                    const tmw = require('../../../node_modules/my-old-space/drive_root/translationMiddleware');
                    const lookup = (lang && lang !== 'en')
                        ? await tmw.getTranslationLookup('tax_categories', lang, modelsDB) : null;
                    for (const c of cats) {
                        const tr = lookup && lookup.get(c.UID + '|invoiceNote');
                        taxCategories[c.UID] = {
                            name: (lookup && lookup.get(c.UID + '|name')) || c.name,
                            invoiceNote: tr !== undefined && tr !== null ? tr : c.invoiceNote,
                            // Признак «на этот оборот скидка распространяется».
                            // false у durchlaufender Posten: курсбор — деньги общины,
                            // отель не вправе их уменьшать (см. раскладку скидки в шаблоне).
                            discountable: c.discountable !== false
                        };
                    }
                }
            } catch (e) { console.warn('[reports] taxCategories resolve:', e && e.message); }

            // Примечание в счёте — из варианта отчёта, выбранного в самом счёте
            // (invoices.reportVariantId → report_variants.invoiceNote).
            // Печатается как есть, без перевода.
            let invoiceNote = '';
            try {
                const rvId = invoice && invoice.reportVariantId;
                if (rvId && modelsDB.ReportVariants) {
                    const variant = await modelsDB.ReportVariants.findByPk(rvId, { raw: true });
                    if (variant && variant.invoiceNote) invoiceNote = String(variant.invoiceNote);
                }
            } catch (e) { console.warn('[reports] invoiceNote resolve:', e && e.message); }

            const i18n = require('../../../node_modules/my-old-space/drive_root/i18n');
            const t = (key) => i18n.t(key, lang);
            const tf = (key, vars) => i18n.tf(key, lang, vars);
            const localeMap = { en: 'en-GB', ru: 'ru-RU', pl: 'pl-PL', de: 'de-DE' };
            const locale = localeMap[lang] || 'de-DE';

            // Сторно обязан ссылаться на исходный счёт (§ 31 Abs. 5 UStDV):
            // без номера и даты отменяемого документа встречный документ не с чем
            // сопоставить.
            let correctsInvoice = null;
            if (invoice.correctsInvoiceId) {
                correctsInvoice = await modelsDB.Invoices.findByPk(invoice.correctsInvoiceId, { raw: true });
            }

            const { html, missingKeys, brutto } = renderInvoiceHTML({
                invoice, bookings, client, hotel, org, lines, t, tf,
                locale, lang, invoiceNote, taxCategories, draft, correctsInvoice
            });

            // Слепок данных, из которых собран HTML, — это и есть «что было в
            // счёте» на момент выставления: имена услуг, адрес организации,
            // ставки. Всё это потом может измениться в справочниках.
            const payload = { invoice, bookings, client, hotel, org, lines, lang, invoiceNote, taxCategories, correctsInvoice };

            return { html, payload, invoice, org, client, lines, lang, draft, missingKeys, brutto };
}

module.exports = { buildInvoiceDoc };
