/**
 * Клиентский скрипт денежных документов.
 *
 * ФОРМАТ ФАЙЛА: это ТЕЛО ФУНКЦИИ, а не модуль. Ядро оборачивает содержимое в
 * `new Function(code)` и берёт возвращённое значение, поэтому `return { … }`
 * обязан стоять на ВЕРХНЕМ уровне файла. Обёртка в IIFE с `return` внутри неё
 * выглядит правильно, но отдаёт `undefined`: наружу возвращать некому — и форма
 * получает скрипт без единой функции, молча, без ошибки в консоли.
 * Образец — `apps/invoice/forms/invoices.client.js`.
 *
 * Кода проведения здесь НЕТ и быть не должно: команды «Провести», «Распровести»,
 * «Провести и закрыть» — ядровые (`"command"` на кнопке лейаута), их подтверждение,
 * вызов, разбор ответа и замок формы живут в одном месте на всю систему
 * (drive_forms/resources/public/UI_classes.js#runDocumentCommand).
 *
 * Остаётся то, что относится только к деньгам: остаток места хранения и печать
 * кассовой книги.
 *
 * Имена серверных скриптов подставляются при регистрации (`__SERVER_SCRIPT__`,
 * `__REPORT_SCRIPT__`) — хардкодить их нельзя: `loadScript` выдаёт новый UID на
 * каждом старте процесса.
 */

/**
 * Остаток места хранения — подсказкой в строке состояния формы.
 * Считает РЕГИСТР (серверная функция), а не клиент: второй способ посчитать
 * остаток однажды показал бы другое число, чем отчёт.
 */
async function showCashboxBalance(ev, ctx) {
    var form = (ctx && ctx.form) || ev;
    try {
        var cashboxId = form.getControlValue && form.getControlValue('cashboxId');
        var organizationId = form.getControlValue && form.getControlValue('organizationId');
        if (!cashboxId) return;
        var res = await window.callServer('__SERVER_SCRIPT__', 'cashboxBalance',
            { cashboxId: cashboxId, organizationId: organizationId });
        if (res && res.ok && form.setStatusText) form.setStatusText(res.balance);
    } catch (e) {
        console.error('[cash] остаток не получен:', e && e.message);
    }
}

/**
 * Печать кассовой книги ТЕКУЩЕГО места хранения за текущий месяц.
 *
 * Книга принадлежит месту хранения, поэтому кнопка стоит на его форме, а не в
 * журнале документов: «кассовая книга наличной кассы», «выписка по счёту».
 *
 * Период пока фиксированный — текущий месяц. Серверная функция принимает
 * `from`/`to` и готова к произвольному отрезку; не хватает формы параметров, и
 * место ей — в `apps/reports`, рядом с прочими отчётами. Печатать «за всё время»
 * вместо месяца было бы хуже: кассовую книгу ведут по периодам, и годовая
 * простыня не читается.
 */
async function printKassenbuch(ev, ctx) {
    var form = (ctx && ctx.form) || ev;
    try {
        var uidEntry = form._dataMap && form._dataMap['UID'];
        var cashboxId = uidEntry && uidEntry.value;
        if (!cashboxId) { showAlert(__t('Please save the record first')); return; }
        var organizationId = form.getControlValue && form.getControlValue('organizationId');

        var now = new Date();
        var from = new Date(now.getFullYear(), now.getMonth(), 1);
        var to = new Date(now.getFullYear(), now.getMonth() + 1, 0);

        var res = await window.callServer('__REPORT_SCRIPT__', 'build', {
            cashboxId: cashboxId,
            organizationId: organizationId,
            from: from.toISOString(),
            to: to.toISOString()
        });
        if (!res || res.error) {
            showAlert(__t('Error: ') + ((res && res.error) || ''));
            return;
        }
        // Отчёт открывается ВНУТРИ ретро-окна приложения, а не новой вкладкой браузера.
        await window.MySpace.open('printPreview', { html: res.html });
    } catch (e) {
        console.error('[cash] кассовая книга:', e && e.message);
        showAlert(__t('Error: ') + (e && e.message || ''));
    }
}

return { showCashboxBalance, printKassenbuch };
