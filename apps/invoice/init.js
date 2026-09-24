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

        // ── Встречные документы: то, что ядру знать неоткуда ──────────────
        // Ядро (drive_root/db/storno.js) копирует документ и инвертирует поля,
        // объявленные в `entityConfig.storno.negate`. Скидка так не объявляется:
        // в режиме «%» инвертировать нечего (процент от уже отрицательной базы
        // сам даёт отрицательную скидку), а в режиме «€» абсолютную сумму
        // инвертировать обязательно — иначе она вычтется из минуса и увеличит
        // долг вместо его отмены.
        // Сторно собирается В ПАМЯТИ для несохранённой формы — хук правит шапку по
        // ссылке, в базе документа ещё нет.
        entityHooks.register('invoice.onStorno', async (params) => {
            const { head, source } = params;
            if (!head || !source || source.discountMode !== 'amount') return;
            const value = Number(source.discountValue) || 0;
            if (!value) return;
            head.discountValue = -value;
        });

        // ── Форма «Счёт» (таблица invoices) ───────────────────────────────
        const invoiceApi = require('./forms/invoices.server')(modelsDB, Utilities);

        // ── Выставление счёта = ПРОВЕДЕНИЕ (ТЗ §5.3) ──────────────────────
        // Для счёта «выставлен» = «проведён», поэтому выставление — обработчик
        // проведения, а кнопка на форме — ядровая команда `post` с подписью
        // «Выставить» (подписи объявляются потаблично в `entityConfig.posting`).
        // Ядро берёт на себя очередь, транзакцию, журнал и замок формы; счёт
        // оставляет за собой то, что знает только он: сборку документа, проверку
        // реквизитов § 14 UStG и архивную копию.
        // Сам обработчик объявлен в `posting.handlers.js`: проведение выполняет
        // форкнутый воркер планировщика, а `init.js` выполняет только главный
        // процесс — регистрация здесь была бы невидима там, где нужна.

        // Обработчик проведения из набора RPC УБИРАЕМ: у него другая сигнатура
        // `(doc, ctx)`, и оставить его вызываемым с клиента значило бы завести
        // второй путь выставления — мимо очереди и мимо замка формы.
        const invoiceRpc = Object.assign({}, invoiceApi);
        delete invoiceRpc.postIssue;
        const serverScriptName = loadServerScript('invoice.actions', invoiceRpc, 'user');

        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/invoices.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, serverScriptName);
        const clientUID = await loadScript(clientSource, 'user');

        await layoutMemory.saveLayout({
            appName:      'uniForm',
            mode:         'record',
            tableName:    'invoices',
            roles:        '*',
            layout:       require('./forms/invoices.layout.json'),
            clientScript: clientUID,
            appCaption:   { i18n: 'invoice_app_caption' },
            recordCaption:{ i18n: 'Invoice' },
            formIcon:     '/apps/booking_icons/resources/public/16x16/invoice.png',
            listIcon:     '/apps/booking_icons/resources/public/16x16/invoice_journal.png',
            events: {
                onBeforeSave: { serverScript: serverScriptName, fn: 'onBeforeSave' },
                // Проведение закончилось — приложению остаётся ЕГО дело, печать:
                // архивная копия к этому моменту снята, и печатать можно из неё, а
                // не живой сборкой (она со временем разойдётся с выданным счётом).
                onPostingFinished: { fn: 'onPostingFinished' }
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
