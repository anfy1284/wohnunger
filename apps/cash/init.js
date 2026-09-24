'use strict';

/**
 * Приложение «Денежные документы» (apps/cash) — ТЗ «Проведение документов», этап 10.
 *
 * Первый настоящий потребитель механизма проведения: поступление и списание денег,
 * перенос между местами хранения, регистр `reg_cash` и кассовая книга.
 *
 * Приложение НЕ пишет ни строчки кода проведения сверх обработчиков (hooks/posting.js)
 * и ни строчки кода распроведения вовсе: движения принадлежат документу, снимает их
 * ядро. Команды «Провести» / «Распровести» / «Провести и закрыть» — ядровые, объявлены
 * кнопками в лейаутах.
 *
 * ── Правовое (кратко; полностью — hooks/posting.js и ТЗ §17) ──────────────────
 * Оплата фиксируется ПОСЛЕ факта. Программа не принимает платёж в момент расчёта,
 * не выдаёт гостю чек, не управляет денежным ящиком и не печатает Z-отчёт — значит,
 * § 146a AO (KassenSichV, TSE) не применяется. Эту границу переходить нельзя.
 */

const path = require('path');
const fs = require('fs');

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../node_modules/my-old-space');
        const layoutMemory = require('../../node_modules/my-old-space/drive_root/layoutMemory');
        const entityHooks = require('../../node_modules/my-old-space/drive_root/entityHooks');

        // ── Обработчики проведения ────────────────────────────────────────
        // ЗДЕСЬ ИХ НЕТ намеренно. Проведение выполняет форкнутый воркер
        // планировщика, а `init.js` выполняет только главный процесс — регистрация
        // здесь была бы невидима там, где нужна, и документ падал бы с
        // «обработчик не зарегистрирован». Объявление — в `posting.handlers.js`,
        // чистом модуле-фабрике, который грузят оба процесса.

        // ── Представления (поле name) ─────────────────────────────────────
        // Номер + дата операции + сумма: по этой строке документ узнаётся в
        // списке ссылок и в кассовой книге.
        const money = require('../../node_modules/my-old-space/drive_root/db/money');
        function cashPresentation(data) {
            const parts = [];
            if (data.number) parts.push(String(data.number));
            const d = data.operationDate ? new Date(data.operationDate) : null;
            if (d && !isNaN(d.getTime())) {
                const p = n => String(n).padStart(2, '0');
                parts.push(`${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`);
            }
            if (data.amount !== undefined && data.amount !== null) {
                parts.push(money.db(money.num(data.amount)));
            }
            return parts.join(' ');
        }
        entityHooks.registerPresentation('cash_receipts', async (data) => cashPresentation(data));
        entityHooks.registerPresentation('cash_payments', async (data) => cashPresentation(data));
        entityHooks.registerPresentation('cash_transfers', async (data) => cashPresentation(data));

        // ── Серверные скрипты ─────────────────────────────────────────────
        const docsScript = loadServerScript(
            'cash.actions',
            require('./forms/cash_documents.server')(modelsDB, Utilities),
            'user'
        );
        const reportScript = loadServerScript(
            'cash.kassenbuch',
            require('./forms/kassenbuch.server')(modelsDB, Utilities),
            'user'
        );

        // ── Клиентский скрипт форм ────────────────────────────────────────
        // Имя серверного скрипта подставляется заменой маркера — хардкодить
        // его в клиентском файле запрещено (он выдаётся заново на каждом старте).
        const clientSource = fs.readFileSync(path.join(__dirname, 'forms/cash.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, docsScript)
            .replace(/__REPORT_SCRIPT__/g, reportScript);
        const clientUID = await loadScript(clientSource, 'user');

        const ICONS = {
            receipt: '/apps/general_icons/resources/public/16x16/document.png',
            journal: '/apps/general_icons/resources/public/16x16/journal.png',
            catalog: '/apps/general_icons/resources/public/16x16/catalog.png',
            cashbook: '/apps/general_icons/resources/public/16x16/cashbook.png'
        };

        // ── Документы ─────────────────────────────────────────────────────
        const DOCS = [
            { table: 'cash_receipts', caption: 'cash_receipts_app_caption', record: 'cash_receipt_record_caption' },
            { table: 'cash_payments', caption: 'cash_payments_app_caption', record: 'cash_payment_record_caption' },
            { table: 'cash_transfers', caption: 'cash_transfers_app_caption', record: 'cash_transfer_record_caption' }
        ];

        for (const doc of DOCS) {
            await layoutMemory.saveLayout({
                appName: 'uniForm',
                mode: 'record',
                tableName: doc.table,
                roles: '*',
                layout: require(`./forms/${doc.table}.layout.json`),
                clientScript: clientUID,
                appCaption: { i18n: doc.caption },
                recordCaption: { i18n: doc.record },
                formIcon: ICONS.receipt,
                listIcon: ICONS.journal,
                events: {
                    onBeforeSave: { serverScript: docsScript, fn: 'onBeforeSave' }
                }
            });
            await layoutMemory.saveLayout({
                appName: 'uniForm',
                mode: 'list',
                tableName: doc.table,
                roles: '*',
                layout: require(`./forms/${doc.table}_list.layout.json`),
                appCaption: { i18n: doc.caption },
                recordCaption: { i18n: doc.record },
                formIcon: ICONS.receipt,
                listIcon: ICONS.journal
            });
            // Журнал денежных документов читается от свежих к старым: вчерашняя
            // запись нужна чаще прошлогодней.
            layoutMemory.registerListSort(doc.table, [{ field: 'number', order: 'desc' }]);
        }

        // ── Справочники ───────────────────────────────────────────────────
        // Формы автогенерируются uniForm: собственной логики у них нет, и
        // рукописный лейаут ради перечисления тех же полей был бы лишним.
        // Проверочный документ каскада: форма автогенерируется, в меню его нет —
        // он служебный, и место ему в административном списке таблиц.
        await layoutMemory.saveLayout({
            appName: 'uniForm', mode: 'list', tableName: 'cash_check_docs', roles: '*',
            layout: [],
            appCaption: { i18n: 'cash_check_app_caption' },
            recordCaption: { i18n: 'cash_check_record_caption' },
            formIcon: ICONS.receipt, listIcon: ICONS.journal
        });

        // Место хранения денег — форма рукописная: на ней кнопка «Кассовая книга».
        // Книга принадлежит месту хранения («кассовая книга наличной кассы»,
        // «выписка по счёту»), поэтому кнопка здесь, а не в журнале документов.
        await layoutMemory.saveLayout({
            appName: 'uniForm', mode: 'record', tableName: 'cashboxes', roles: '*',
            layout: require('./forms/cashboxes.layout.json'),
            clientScript: clientUID,
            appCaption: { i18n: 'cash_cashboxes_app_caption' },
            recordCaption: { i18n: 'cash_cashboxes_app_caption' },
            listIcon: ICONS.catalog, formIcon: ICONS.catalog
        });
        await layoutMemory.saveLayout({
            appName: 'uniForm', mode: 'list', tableName: 'cashboxes', roles: '*',
            layout: require('./forms/cashboxes_list.layout.json'),
            appCaption: { i18n: 'cash_cashboxes_app_caption' },
            listIcon: ICONS.catalog, formIcon: ICONS.catalog
        });

        // Виды операции — автоформа: собственной логики у справочника нет.
        await layoutMemory.saveLayout({
            appName: 'uniForm', mode: 'list', tableName: 'cash_operation_types', roles: '*',
            layout: [],
            appCaption: { i18n: 'cash_operation_types_app_caption' },
            listIcon: ICONS.catalog, formIcon: ICONS.catalog
        });

        // ── Меню ──────────────────────────────────────────────────────────
        const mainMenu = require('../../node_modules/my-old-space/apps/main_menu/server.js');
        mainMenu.addMenuItems([{
            id: 'main',
            items: [
                {
                    caption: { i18n: 'cash_receipts_app_caption' },
                    action: 'open', singleton: true, appName: 'uniForm', order: 95,
                    icon: ICONS.journal,
                    params: { mode: 'list', dbTable: 'cash_receipts' }
                },
                {
                    caption: { i18n: 'cash_payments_app_caption' },
                    action: 'open', singleton: true, appName: 'uniForm', order: 96,
                    icon: ICONS.journal,
                    params: { mode: 'list', dbTable: 'cash_payments' }
                },
                {
                    caption: { i18n: 'cash_transfers_app_caption' },
                    action: 'open', singleton: true, appName: 'uniForm', order: 97,
                    icon: ICONS.journal,
                    params: { mode: 'list', dbTable: 'cash_transfers' }
                },
                // Места хранения денег — отсюда печатается кассовая книга.
                {
                    caption: { i18n: 'cash_cashboxes_app_caption' },
                    action: 'open', singleton: true, appName: 'uniForm', order: 98,
                    icon: ICONS.cashbook,
                    params: { mode: 'list', dbTable: 'cashboxes' }
                }
            ]
        }]);

        console.log('[cash/init] Layouts, posting handlers and menu registered');
    } catch (e) {
        console.error('[cash/init] Failed:', e && e.message || e);
        console.error(e && e.stack);
    }
};
