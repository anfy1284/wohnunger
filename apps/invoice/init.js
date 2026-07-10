'use strict';

// Точка регистрации форм приложения "invoice" — документ «Счёт».
// Автоматически вызывается фреймворком при старте (drive_forms/init.js).
//
// Счёт — самостоятельный документ (не ТЧ брони): ТЧ «Бронирования»
// (может объединять несколько броней) + редактируемая ТЧ «Строки счёта»
// (пересоздаётся кнопкой «Заполнить»). Печать — из счёта (reports).
//
// Структура приложения (паттерн разделённых файлов, эталон — apps/booking):
//   forms/invoices.layout.json — JSON-лейаут формы записи
//   forms/invoices.server.js   — серверные функции (fillInvoice, createFromBooking, ...)
//   forms/invoices.client.js   — клиентский JS (__SERVER_SCRIPT__ заменяется ниже)
//   db/db.json                 — схема БД (документ + 2 ТЧ)
//   i18n.json                  — переводы

const path = require('path');
const fs   = require('fs');

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../node_modules/my-old-space');
        const layoutMemory = require('../../node_modules/my-old-space/drive_root/layoutMemory');
        const entityHooks  = require('../../node_modules/my-old-space/drive_root/entityHooks');

        // ── Представление документа «Счёт» (поле name) ────────────────────
        // number + имя клиента + дата документа (dd.MM.yyyy) — по образцу брони.
        entityHooks.registerPresentation('invoices', async (data, ctx) => {
            const parts = [];
            if (data.number) parts.push(String(data.number));

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

            if (data.date) {
                const dt = new Date(data.date);
                if (!isNaN(dt.getTime())) {
                    const p = n => String(n).padStart(2, '0');
                    parts.push(`${p(dt.getDate())}.${p(dt.getMonth() + 1)}.${dt.getFullYear()}`);
                }
            }

            return parts.join(' ');
        });

        // ── Форма «Счёт» (таблица invoices) ───────────────────────────────
        const serverScriptName = loadServerScript(
            'invoice.actions',
            require('./forms/invoices.server')(modelsDB, Utilities),
            'user'
        );

        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/invoices.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, serverScriptName);
        const clientUID = await loadScript(clientSource, 'user');

        await layoutMemory.saveLayout({
            appName:      'uniForm',
            mode:         'record',
            tableName:    'invoices',
            roles:        'user',
            layout:       require('./forms/invoices.layout.json'),
            clientScript: clientUID,
            appCaption:   { i18n: 'invoice_app_caption' },
            recordCaption:{ i18n: 'Invoice' },
            formIcon:     '/apps/booking_icons/resources/public/16x16/invoice.png',
            listIcon:     '/apps/booking_icons/resources/public/16x16/invoice_journal.png',
            events: {
                onBeforeSave: { serverScript: serverScriptName, fn: 'onBeforeSave' }
            }
        });
        // Список — автогенерация uniForm (заголовок/иконка из appCaption/listIcon).

        // ── Сортировка журнала: по номеру от большего к меньшему ──────────
        layoutMemory.registerListSort('invoices', [{ field: 'number', order: 'desc' }]);

        // ── Пункт главного меню ────────────────────────────────────────────
        const mainMenu = require('../../node_modules/my-old-space/apps/main_menu/server.js');
        mainMenu.addMenuItems([
            {
                id: 'invoices',
                caption: { i18n: 'invoice_app_caption' },
                action: 'open',
                singleton: true,
                appName: 'uniForm',
                icon: '/apps/booking_icons/resources/public/16x16/invoice_journal.png',
                params: { mode: 'list', dbTable: 'invoices' }
            }
        ]);

        console.log('[invoice/init] Layouts registered');
    } catch (e) {
        console.error('[invoice/init] Failed:', e && e.message || e);
    }
};
