'use strict';

// Общие справочники прикладного решения: организации, отели, номера,
// услуги, типы гостей, клиенты.
// Описание моделей — в db/db.json.
// Дефолтные значения (типы гостей) — в db/defaultValues.json.

const path = require('path');
const fs   = require('fs');

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../node_modules/my-old-space');
        const layoutMemory   = require('../../node_modules/my-old-space/drive_root/layoutMemory');

        // ── Кастомная форма записи «Услуга» ──────────────────────────────
        // Нужна ради поля «Формула расчёта количества» (quantityFormula) с
        // кнопкой «...», открывающей редактор формул (приложение formula_editor).
        const servicesClient = fs.readFileSync(path.join(__dirname, 'forms/services.client.js'), 'utf8');
        const servicesClientUID = await loadScript(servicesClient, 'user');

        await layoutMemory.saveLayout({
            appName:       'uniForm',
            mode:          'record',
            tableName:     'services',
            roles:         'user',
            layout:        require('./forms/services.layout.json'),
            clientScript:  servicesClientUID,
            appCaption:    { i18n: 'services' },
            recordCaption: { i18n: 'service_record_caption' }
        });

        console.log('[common/init] Services layout registered');

        // ── Справочник «Сезоны» (таблица seasons + ТЧ season_periods) ────
        // Сезон — именованный набор дат-периодов (могут повторяться из года
        // в год). Строки проживания прайс-листа ссылаются на сезон, а не на
        // пару дат von/bis; резолв цены по дате проживания — через периоды
        // сезона (apps/common/lib/priceResolver.js).
        const seasonsServerScript = loadServerScript(
            'seasons.actions',
            require('./forms/seasons.server')(modelsDB, Utilities),
            'user'
        );

        await layoutMemory.saveLayout({
            appName:       'uniForm',
            mode:          'record',
            tableName:     'seasons',
            roles:         'user',
            layout:        require('./forms/seasons.layout.json'),
            appCaption:    { i18n: 'seasons_app_caption' },
            recordCaption: { i18n: 'season_record_caption' },
            formIcon:      '/apps/general_icons/resources/public/16x16/calendar.png',
            listIcon:      '/apps/general_icons/resources/public/16x16/catalog.png',
            events: {
                onBeforeSave: { serverScript: seasonsServerScript, fn: 'onBeforeSave' }
            }
        });
        // Список — автогенерация uniForm (заголовок/иконка из appCaption/listIcon).

        // ── Пункт в подменю «Справочники» главной кнопки ─────────────────
        // Группа создана в apps/reports/init.js (order 900); пункты с тем же
        // caption мерджатся в неё на клиенте.
        const mainMenu = require('../../node_modules/my-old-space/apps/main_menu/server.js');
        mainMenu.addMenuItems([
            {
                id: 'main',
                items: [
                    {
                        caption: { i18n: 'directories_submenu' },
                        order: 900,
                        icon: '/apps/general_icons/resources/public/16x16/catalog.png',
                        items: [
                            {
                                caption: { i18n: 'seasons_app_caption' },
                                action: 'open',
                                singleton: true,
                                appName: 'uniForm',
                                icon: '/apps/general_icons/resources/public/16x16/calendar.png',
                                params: { mode: 'list', dbTable: 'seasons' }
                            }
                        ]
                    }
                ]
            }
        ]);

        console.log('[common/init] Seasons layout registered');
    } catch (e) {
        console.error('[common/init] Failed:', e && e.message || e);
    }
};
