'use strict';

// ─────────────────────────────────────────────────────────────────────
// Приложение «Отчёты» (reports).
// Серверные функции генерации печатных форм.
// Каждый отчёт хранится в своей подпапке: reports/invoice/, reports/...
// ─────────────────────────────────────────────────────────────────────
const { tForSession } = require('../../node_modules/my-old-space/drive_forms/globalServerContext');
const { resolveOrgReportLang } = require('../common/lib/orgReportLanguage');

module.exports = async function (modelsDB) {
    try {
        const { loadServerScript } = require('../../node_modules/my-old-space');
        const layoutMemory = require('../../node_modules/my-old-space/drive_root/layoutMemory');
        // Сборка счёта вынесена в invoice/build.js — её зовут и печать, и команда
        // «Выставить» (снимок в архив); HTML обязан быть один и тот же.
        const { buildInvoiceDoc } = require('./invoice/build');
        const documentArchive = require('../../node_modules/my-old-space/drive_root/db/documentArchive');
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
            // Печатная форма счёта.
            //
            // Выставленный счёт печатается ТОЛЬКО из архива: живая пересборка через
            // год даст другой документ — услугу переименовали, адрес организации
            // сменился, шаблон поправили. Копия обязана совпадать с выданной.
            // Черновик собирается живьём и печатается с пометкой «Entwurf».
            async generateInvoiceHTML({ invoiceId } = {}, ctx) {
                if (!invoiceId) return { error: await tForSession('invoiceId required', ctx.sessionID) };

                const invoice = await modelsDB.Invoices.findByPk(invoiceId, { raw: true });
                if (!invoice) return { error: await tForSession('Invoice not found', ctx.sessionID) };

                const isDraft = !invoice.status || invoice.status === 'draft';

                if (!isDraft) {
                    const snap = await documentArchive.load('invoices', invoiceId);
                    if (snap) {
                        const check = documentArchive.verify(snap);
                        if (!check.ok) {
                            // Снимок есть, но контрольная сумма не сходится — файл
                            // правили в обход приложения. Молчать нельзя: пользователь
                            // должен знать, что копия под сомнением.
                            console.error('[reports] archive sha256 mismatch for invoice', invoiceId, check);
                        }
                        return { html: snap.html, fromArchive: true, sha256: snap.sha256, tampered: !check.ok };
                    }
                    // Снимка нет — счёт выставлен до появления архива. Собираем
                    // живьём, но честно помечаем, что это не архивная копия.
                    try {
                        const { html } = await buildInvoiceDoc(modelsDB, invoiceId, { draft: false });
                        return { html, fromArchive: false, noSnapshot: true };
                    } catch (e) {
                        return { error: await tForSession((e && e.message) || String(e), ctx.sessionID) };
                    }
                }

                try {
                    const { html } = await buildInvoiceDoc(modelsDB, invoiceId, { draft: true });
                    return { html, draft: true };
                } catch (e) {
                    return { error: await tForSession((e && e.message) || String(e), ctx.sessionID) };
                }
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

                // Язык печати — из настроек организации (настройка project.reportLanguage).
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
