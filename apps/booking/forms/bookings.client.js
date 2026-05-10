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

// Вызывается при активации строки в таблице номеров.
// rowIndex — аргумент от onRowActivate, ctx — контекст формы.
function onRoomActivated(rowIndex, ctx) {
    console.log('Выбран номер, строка:', rowIndex);
}

async function printInvoice(ev, ctx) {
    var form = ctx.form;
    var uidEntry = form._dataMap && form._dataMap['UID'];
    var bookingId = uidEntry && uidEntry.value;
    if (!bookingId) { showAlert(__t('Please save the booking first')); return; }

    // Если форма изменена — предложить сохранить (пересчёт счёта произойдёт автоматически в onBeforeSave)
    if (form._modified) {
        var ok = await showConfirm(__t('Save before printing?'));
        if (!ok) return;
        await form.doAction('save');
        if (form._modified) return; // сохранение не удалось, ошибка уже показана
    }

    var result = await callServer('reports.actions', 'generateInvoiceHTML', { bookingId: bookingId });
    if (result.error) { showAlert(__t('Error: ') + result.error); return; }

    if (window.MySpace && typeof window.MySpace.open === 'function') {
        await window.MySpace.open('printPreview', { html: result.html, autoPrint: true });
    }
}

return { onRoomActivated, printInvoice };
