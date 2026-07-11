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
        const layoutMemory = require('../../node_modules/my-old-space/drive_root/layoutMemory');
        const { renderInvoiceHTML } = require('./invoice/template');
        const { renderPriceListHTML } = require('./priceList/template');

        // ── Справочник «Варианты отчёта» (таблица report_variants) ───────────
        // Хранит предзаданные примечания в счёте (invoiceNote). Вариант выбирается
        // в документе бронирования; при печати счёта примечание берётся отсюда.
        // Форма записи — кастомный лейаут (имя + многострочное примечание);
        // список — автогенерация uniForm, заголовок/иконка из appCaption/listIcon.
        await layoutMemory.saveLayout({
            appName:       'uniForm',
            mode:          'record',
            tableName:     'report_variants',
            roles:         'user',
            layout:        require('./forms/report_variants.layout.json'),
            appCaption:    { i18n: 'report_variants' },
            recordCaption: { i18n: 'report_variant_record_caption' },
            formIcon:      '/apps/general_icons/resources/public/16x16/document.png',
            listIcon:      '/apps/general_icons/resources/public/16x16/catalog.png'
        });

        // ── Подменю «Справочники» под главной кнопкой (в самом низу) ─────────
        // Группа-контейнер в выпадающем меню Пуск (id: 'main'). order: 900 —
        // ниже настроек организации (order: 101), т.е. в самом низу. Внутрь
        // кладём список вариантов отчёта; сюда же другие приложения могут
        // добавлять свои справочники (мерджатся по caption на клиенте).
        const mainMenu = require('../../node_modules/my-old-space/apps/main_menu/server.js');
        const ICON_CATALOG = '/apps/general_icons/resources/public/16x16/catalog.png';
        mainMenu.addMenuItems([
            {
                id: 'main',
                items: [
                    {
                        caption: { i18n: 'directories_submenu' },
                        order: 900,
                        icon: ICON_CATALOG,
                        items: [
                            {
                                caption: { i18n: 'report_variants' },
                                action: 'open',
                                singleton: true,
                                appName: 'uniForm',
                                icon: ICON_CATALOG,
                                params: { mode: 'list', dbTable: 'report_variants' }
                            }
                        ]
                    }
                ]
            }
        ]);

        // ── Серверный скрипт: отчёты ────────────────────────────────────
        loadServerScript('reports.actions', {

            // Генерация HTML-счёта (Rechnung) по invoiceId (документ invoices).
            // Строки — invoice_lines счёта; брони — через ТЧ invoice_bookings
            // (шапке нужны даты проживания; клиент — из invoices.clientId).
            async generateInvoiceHTML({ invoiceId } = {}, ctx) {
                if (!invoiceId) return { error: await tForSession('invoiceId required', ctx.sessionID) };

                const invoice = await modelsDB.Invoices.findByPk(invoiceId, { raw: true });
                if (!invoice) return { error: await tForSession('Invoice not found', ctx.sessionID) };

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
                if (!lines.length) return { error: await tForSession('No invoice lines. Fill the invoice first.', ctx.sessionID) };

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

                const i18n = require('../../node_modules/my-old-space/drive_root/i18n');
                const t = (key) => i18n.t(key, lang);
                const tf = (key, vars) => i18n.tf(key, lang, vars);
                const localeMap = { en: 'en-GB', ru: 'ru-RU', pl: 'pl-PL', de: 'de-DE' };
                const locale = localeMap[lang] || 'de-DE';

                const html = renderInvoiceHTML({ invoice, bookings, client, hotel, org, lines, t, tf, locale, lang, invoiceNote });
                return { html };
            },

            // Генерация печатной формы прайс-листа (только тарифная таблица)
            // по priceListId (документ price_lists). Строки — ТЧ проживания
            // документа КАК ХРАНЯТСЯ (WYSIWYG); сезоны/периоды — из справочника
            // seasons/season_periods; комнаты — для заголовков групп колонок.
            async generatePriceListHTML({ priceListId } = {}, ctx) {
                if (!priceListId) return { error: await tForSession('priceListId required', ctx.sessionID) };

                const priceList = await modelsDB.PriceLists.findByPk(priceListId, { raw: true });
                if (!priceList) return { error: await tForSession('Price list not found', ctx.sessionID) };

                // Порядок строк = порядок ввода в ТЧ (createdAt) — печать
                // воспроизводит сетку так, как её заполнил пользователь.
                const rows = await modelsDB.PriceListRoomPrices.findAll({
                    where: { priceListId },
                    order: [['createdAt', 'ASC']],
                    raw: true
                });
                if (!rows.length) return { error: await tForSession('No accommodation prices in the price list.', ctx.sessionID) };

                const seasonIds = [...new Set(rows.map(r => r.seasonId).filter(Boolean))];
                const roomIds   = [...new Set(rows.map(r => r.roomId).filter(Boolean))];
                const [seasons, periods, rooms] = await Promise.all([
                    modelsDB.Seasons.findAll({ where: { UID: seasonIds }, raw: true }),
                    modelsDB.SeasonPeriods.findAll({ where: { seasonId: seasonIds }, raw: true }),
                    modelsDB.Rooms.findAll({ where: { UID: roomIds }, raw: true })
                ]);
                const seasonsById = {};
                for (const s of seasons) seasonsById[s.UID] = s;
                const periodsBySeason = {};
                for (const p of periods) (periodsBySeason[p.seasonId] = periodsBySeason[p.seasonId] || []).push(p);
                const roomsById = {};
                for (const r of rooms) roomsById[r.UID] = r;

                // Язык печати — из настроек организации (organizationSettings → reportLanguage).
                const lang = await resolveOrgReportLang(modelsDB, priceList.organizationId);
                const i18n = require('../../node_modules/my-old-space/drive_root/i18n');
                const t = (key) => i18n.t(key, lang);
                const tf = (key, vars) => i18n.tf(key, lang, vars);
                const localeMap = { en: 'en-GB', ru: 'ru-RU', pl: 'pl-PL', de: 'de-DE' };
                const locale = localeMap[lang] || 'de-DE';

                const html = renderPriceListHTML({ priceList, rows, seasonsById, periodsBySeason, roomsById, t, tf, locale, lang });
                return { html };
            },

        }, 'user');

        console.log('[reports/init] Report server scripts registered');
    } catch (e) {
        console.error('[reports/init] Failed to register:', e && e.message || e);
    }
};
