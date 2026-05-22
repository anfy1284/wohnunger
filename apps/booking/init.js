'use strict';

// Точка регистрации форм приложения "booking".
// Автоматически вызывается фреймворком при старте (drive_forms/init.js).
//
// Структура приложения:
//   forms/
//     <tableName>.layout.json  — JSON-лейаут формы (без кода)
//     <tableName>.server.js    — серверные функции: module.exports = (modelsDB, Utilities) => ({ ... })
//     <tableName>.client.js    — клиентский JS-код (plain text); __SERVER_SCRIPT__ заменяется ниже
//   db/db.json                 — схема БД
//   i18n.json                  — переводы

const path = require('path');
const fs   = require('fs');

const APP_ICON = '/apps/booking_icons/resources/public/16x16/booking_status.png';

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../node_modules/my-old-space');
        const layoutMemory = require('../../node_modules/my-old-space/drive_root/layoutMemory');
        const entityHooks  = require('../../node_modules/my-old-space/drive_root/entityHooks');

        // ── Регистрация пользовательских хуков таблицы bookings ──────────────
        const bookingHooks = require('./hooks/bookingHooks');
        entityHooks.register('booking.onBeforeCreate', bookingHooks.onBeforeCreate);

        // ── Форма «Бронирование» (таблица bookings) ──────────────────────

        const serverScriptName = loadServerScript(
            'booking.bookingActions',
            require('./forms/bookings.server')(modelsDB, Utilities),
            'user'
        );

        // Подставляем имя серверного скрипта вместо плейсхолдера __SERVER_SCRIPT__
        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/bookings.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, serverScriptName);
        const clientUID = await loadScript(clientSource, 'user');

        await layoutMemory.saveLayout({
            appName:      'uniForm',
            mode:         'record',
            tableName:    'bookings',
            roles:        'user',
            layout:       require('./forms/bookings.layout.json'),
            clientScript: clientUID,
            windowState:  'maximized',
            formIcon:     APP_ICON,
            appCaption:   { i18n: 'bookings_app_caption' },
            events: {
                onBeforeSave: { serverScript: serverScriptName, fn: 'onBeforeSave' }
            }
        });

        // ── Сюда добавлять новые формы по той же схеме ───────────────────
        // const invoicesServerName = loadServerScript('booking.invoiceActions',
        //     require('./forms/invoices.server')(modelsDB, Utilities), 'user');
        // ...

        // ── Пункт главного меню ─────────────────────────────────────────
        const mainMenu = require('../../node_modules/my-old-space/apps/main_menu/server.js');
        mainMenu.addMenuItems([
            {
                id: 'bookings',
                caption: { i18n: 'bookings_app_caption' },
                action: 'open',
                singleton: true,
                appName: 'uniForm',
                params: { mode: 'list', dbTable: 'bookings' }
            }
        ]);

        console.log('[booking/init] Layouts registered');
    } catch (e) {
        console.error('[booking/init] Failed:', e && e.message || e);
    }
};
