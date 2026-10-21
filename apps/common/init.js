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
        const formMethods    = require('../../node_modules/my-old-space/drive_root/formMethods');
        const APP = 'common';

        // ── Кастомная форма записи «Услуга» ──────────────────────────────
        // Нужна ради поля «Формула расчёта количества» (quantityFormula) с
        // кнопкой «...», открывающей редактор формул (приложение formula_editor).
        const servicesClient = fs.readFileSync(path.join(__dirname, 'forms/services.client.js'), 'utf8');
        const servicesClientUID = await loadScript(servicesClient, 'user');

        await layoutMemory.saveLayout({
            app:           APP,
            subject:       { table: 'services', kind: 'record' },
            roles:         '*',
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
        const seasonsFns = require('./forms/seasons.server')(modelsDB, Utilities);
        // Методы ФОРМЫ сезона — здесь же её серверное событие `onBeforeSave`.
        formMethods.register({
            app: APP, subject: { table: 'seasons', kind: 'record' },
            methods: seasonsFns, roles: ['user', 'admin']
        });
        const seasonsServerScript = loadServerScript('seasons.actions', seasonsFns, 'user');

        await layoutMemory.saveLayout({
            app:           APP,
            subject:       { table: 'seasons', kind: 'record' },
            roles:         '*',
            layout:        require('./forms/seasons.layout.json'),
            appCaption:    { i18n: 'seasons_app_caption' },
            recordCaption: { i18n: 'season_record_caption' },
            formIcon:      '/apps/general_icons/resources/public/16x16/calendar.png',
            listIcon:      '/apps/general_icons/resources/public/16x16/catalog.png'
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
                            // Основные справочники сотрудника (15.10.2026). Раньше до них
                            // можно было добраться только кнопкой «…» в поле выбора на
                            // форме: поправить адрес клиента или добавить услугу значило
                            // сначала открыть какую-нибудь бронь. Глобальные справочники
                            // (типы гостей, ставки НДС, статусы) сюда НЕ входят: их правка
                            // меняет данные всех организаций — это дело администратора.
                            {
                                caption: { i18n: 'clients' },
                                action: 'open', singleton: true, appName: 'uniForm',
                                icon: '/apps/booking_icons/resources/public/16x16/client.png',
                                params: { mode: 'list', dbTable: 'clients' }
                            },
                            {
                                caption: { i18n: 'hotels' },
                                action: 'open', singleton: true, appName: 'uniForm',
                                icon: '/apps/booking_icons/resources/public/16x16/hotel.png',
                                params: { mode: 'list', dbTable: 'hotels' }
                            },
                            {
                                caption: { i18n: 'rooms' },
                                action: 'open', singleton: true, appName: 'uniForm',
                                icon: '/apps/booking_icons/resources/public/16x16/room.png',
                                params: { mode: 'list', dbTable: 'rooms' }
                            },
                            {
                                caption: { i18n: 'services' },
                                action: 'open', singleton: true, appName: 'uniForm',
                                icon: '/apps/booking_icons/resources/public/16x16/service.png',
                                params: { mode: 'list', dbTable: 'services' }
                            },
                            {
                                caption: { i18n: 'organizations' },
                                action: 'open', singleton: true, appName: 'uniForm',
                                icon: '/apps/general_icons/resources/public/16x16/organization.png',
                                params: { mode: 'list', dbTable: 'organizations' }
                            },
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
