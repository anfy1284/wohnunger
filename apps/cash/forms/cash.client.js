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
 * Остаётся то, что относится только к деньгам: печать кассовой книги.
 *
 * Подсказки остатка здесь НЕТ: она была написана, но ни к одному событию
 * лейаута не привязана — то есть не работала ни разу. Удалена вместе со своей
 * серверной парой (24.09.2026). Экспортировать функцию не значит подключить её;
 * проверка — грепнуть имя по *.layout.json.
 *
 * Имена серверных скриптов подставляются при регистрации (`__SERVER_SCRIPT__`,
 * `__REPORT_SCRIPT__`) — хардкодить их нельзя: `loadScript` выдаёт новый UID на
 * каждом старте процесса.
 */

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

        // Период — МЕСЯЦ ЦЕЛИКОМ, границами суток. Раньше здесь стояло
        // `new Date(год, месяц + 1, 0)`, а это ПОЛНОЧЬ последнего дня: весь
        // 30-й (31-й) день месяца не попадал в книгу вместе с конечным
        // остатком. Границы считает ядро (MySpace.startOfMonth/endOfMonth),
        // чтобы правило было одно на всю программу.
        var now = new Date();
        var from = window.MySpace.startOfMonth(now);
        var to = window.MySpace.endOfMonth(now);

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

return { printKassenbuch };
