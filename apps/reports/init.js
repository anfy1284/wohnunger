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

                // Примечание в счёте — свободный текст из выбранного в брони
                // варианта отчёта (report_variants → invoiceNote). Печатается КАК ЕСТЬ,
                // на том языке, на котором его ввёл пользователь (перевода нет).
                // Вариант не выбран или примечание пустое → блок не выводится.
                let invoiceNote = '';
                try {
                    if (booking.reportVariantId && modelsDB.ReportVariants) {
                        const variant = await modelsDB.ReportVariants.findByPk(booking.reportVariantId, { raw: true });
                        if (variant && variant.invoiceNote) invoiceNote = String(variant.invoiceNote);
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
