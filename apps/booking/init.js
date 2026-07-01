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

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../node_modules/my-old-space');
        const layoutMemory = require('../../node_modules/my-old-space/drive_root/layoutMemory');
        const entityHooks  = require('../../node_modules/my-old-space/drive_root/entityHooks');

        // ── Регистрация пользовательских хуков таблицы bookings ──────────────
        const bookingHooks = require('./hooks/bookingHooks');
        entityHooks.register('booking.onBeforeCreate', bookingHooks.onBeforeCreate);

        // ── Представление документа «Бронирование» (поле name) ───────────────
        // «Специальный метод документа»: фреймворк (applyPresentation) вызывает его
        // ВСЕГДА при сохранении (create/update) и пишет результат в name.
        // Для брони: номер + имя клиента + даты заезда–выезда.
        entityHooks.registerPresentation('bookings', async (data, ctx) => {
            const parts = [];
            if (data.number) parts.push(String(data.number));

            // Имя клиента по clientId (FK → clients.name)
            if (data.clientId && ctx && ctx.modelsDB) {
                const Clients = ctx.modelsDB.Clients
                    || Object.values(ctx.modelsDB).find(m => m && m.tableName === 'clients');
                if (Clients) {
                    try {
                        const c = await Clients.findByPk(data.clientId, { raw: true });
                        if (c && c.name) parts.push(c.name);
                    } catch (e) { /* без имени клиента */ }
                }
            }

            // Даты заезда–выезда (dd.MM.yyyy)
            const fmt = (v) => {
                if (!v) return '';
                const dt = new Date(v);
                if (isNaN(dt.getTime())) return String(v);
                const p = n => String(n).padStart(2, '0');
                return `${p(dt.getDate())}.${p(dt.getMonth() + 1)}.${dt.getFullYear()}`;
            };
            const ci = fmt(data.checkIn), co = fmt(data.checkOut);
            if (ci || co) parts.push(`${ci}–${co}`);

            return parts.join(' ');
        });

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
            appCaption:   { i18n: 'bookings_app_caption' },
            recordCaption:{ i18n: 'Booking' },
            events: {
                onBeforeSave: { serverScript: serverScriptName, fn: 'onBeforeSave' },
                onChange:     { fn: 'onFormChange' }
            }
        });

        // ── Кастомная форма СПИСКА броней: вкладки «Список» + «Календарь» ─────
        // Календарь (фреймворковый элемент type:'calendar') тянет данные через
        // window.callServer(serverScript, 'loadCalendar', ...). Имя серверного
        // скрипта внедряем в свойства календаря в лейауте (аналог __SERVER_SCRIPT__).
        // Клиентский скрипт списку не нужен — календарь самодостаточен.
        const listServerName = loadServerScript(
            'booking.bookingListActions',
            require('./forms/bookings_list.server')(modelsDB, Utilities),
            'user'
        );

        const listLayout = require('./forms/bookings_list.layout.json');
        (function injectCalendarServerScript(items) {
            if (!Array.isArray(items)) return;
            for (const it of items) {
                if (it && it.type === 'calendar') {
                    it.properties = it.properties || {};
                    it.properties.serverScript = listServerName;
                    it.properties.loadFn = 'loadCalendar';
                }
                if (it && Array.isArray(it.layout)) injectCalendarServerScript(it.layout);
                if (it && Array.isArray(it.tabs)) {
                    for (const t of it.tabs) injectCalendarServerScript(t.layout);
                }
            }
        })(listLayout);

        await layoutMemory.saveLayout({
            appName:     'uniForm',
            mode:        'list',
            tableName:   'bookings',
            roles:       'user',
            layout:      listLayout,
            windowState: 'maximized',
            appCaption:  { i18n: 'bookings_app_caption' },
            listIcon:    '/apps/general_icons/resources/public/16x16/journal.png'
        });

        // ── Сюда добавлять новые формы по той же схеме ───────────────────
        // const invoicesServerName = loadServerScript('booking.invoiceActions',
        //     require('./forms/invoices.server')(modelsDB, Utilities), 'user');
        // ...

        // ── Сортировка списка броней по умолчанию: по номеру от большего к меньшему ──
        layoutMemory.registerListSort('bookings', [{ field: 'number', order: 'desc' }]);

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
