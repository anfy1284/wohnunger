// Клиентские функции формы "Бронирование".
//
// Этот файл загружается как исходный текст через loadScript() в init.js.
// Плейсхолдер __SERVER_SCRIPT__ заменяется на реальное имя серверного скрипта при загрузке.
//
// Сигнатура обработчиков: function(eventArgs..., ctx)
//   ctx.form    — DataForm текущей формы
//   ctx.fnParams — параметры из лейаута (с резолвом {data.field})
//
// Файл должен заканчиваться return { ... } — этого требует loadScript().

function sayHello(ev, ctx) {
    var name = ctx.fnParams && ctx.fnParams.name;
    showAlert(__t('Hello, ') + (name || __t('stranger')) + '!');
}

function say(ev, ctx) {
    var p = ctx.fnParams || {};
    showAlert(p.name + ': ' + p.message);
}

async function showBookingStatus(ev, ctx) {
    var bookingId = ctx.fnParams && ctx.fnParams.bookingId;
    if (!bookingId) {
        var uidEntry = ctx.form._dataMap && ctx.form._dataMap['UID'];
        bookingId = uidEntry && uidEntry.value;
    }
    var result = await callServer('__SERVER_SCRIPT__', 'getBookingStatus', { bookingId });
    if (result.error) { showAlert(__t('Error: ') + result.error); return; }
    showAlert(__t('Booking: ') + result.name + '\n' + __t('Status: ') + result.status);
}

// Вызывается при активации строки в таблице номеров.
// rowIndex — аргумент от onRowActivate, ctx — контекст формы.
function onRoomActivated(rowIndex, ctx) {
    console.log('Выбран номер, строка:', rowIndex);
}

async function calculateCost(ev, ctx) {
    var form = ctx.form;
    var uidEntry = form._dataMap && form._dataMap['UID'];
    var bookingId = uidEntry && uidEntry.value;
    if (!bookingId) { showAlert(__t('Please save the booking first')); return; }

    var result = await callServer('__SERVER_SCRIPT__', 'calculateBookingCost', { bookingId: bookingId });
    if (result.error) { showAlert(__t('Error: ') + result.error); return; }

    // Перезаписать данные ТЧ invoice_lines
    var tbl = form.controlsMap['ts_invoice_lines'];
    if (tbl) {
        var rows = tbl.data_getRows('invoice_lines');
        rows.length = 0;
        var newLines = result.lines || [];
        for (var i = 0; i < newLines.length; i++) rows.push(newLines[i]);
        if (tbl._invokeRenderBodyRows) tbl._invokeRenderBodyRows();
    }
    form.setModified(true);
    showAlert(__t('Calculation complete: ') + (result.lines ? result.lines.length : 0) + ' ' + __t('lines'));
}

async function printInvoice(ev, ctx) {
    var form = ctx.form;
    var uidEntry = form._dataMap && form._dataMap['UID'];
    var bookingId = uidEntry && uidEntry.value;
    if (!bookingId) { showAlert(__t('Please save the booking first')); return; }

    var result = await callServer('reports.actions', 'generateInvoiceHTML', { bookingId: bookingId });
    if (result.error) { showAlert(__t('Error: ') + result.error); return; }

    if (window.MySpace && typeof window.MySpace.open === 'function') {
        await window.MySpace.open('printPreview', { html: result.html, autoPrint: true });
    }
}

return { sayHello, say, showBookingStatus, onRoomActivated, calculateCost, printInvoice };
