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
//
// Стандартные кнопки OK / Save / Cancel рендерятся через тип "commandBar" в лейауте —
// их обработчики встроены в DataForm (doAction 'ok' / 'save' / 'cancel').
// Здесь остаются только специфические для booking функции.

// Вызывается при активации строки в таблице номеров.
// Автоматически добавляет дефолтные услуги для номера, если их ещё нет.
async function onRoomActivated(rowIndex, ctx) {
    var form = ctx.form;
    var hotelEntry = form._dataMap && form._dataMap['hotelId'];
    var hotelId = hotelEntry && hotelEntry.value;
    if (!hotelId) return;

    // rowIndex — индекс активированного номера прямо в этой таблице
    var roomsTbl = form.controlsMap && form.controlsMap['ts_booking_rooms'];
    if (!roomsTbl) return;
    var roomRows = roomsTbl.data_getRows(roomsTbl.dataKey);
    var activeRoom = roomRows[rowIndex];
    if (!activeRoom || !activeRoom.UID) return;
    var bookingRoomId = activeRoom.UID;

    // Идемпотентность: если услуги для этого номера уже есть — выходим
    var svcTbl = form.controlsMap && form.controlsMap['ts_booking_room_services'];
    if (!svcTbl) return;
    var existingRows = svcTbl.data_getRows(svcTbl.dataKey);
    var alreadyHas = existingRows.some(function(r) { return r.bookingRoomId === bookingRoomId; });
    if (alreadyHas) return;

    var result = await callServer('__SERVER_SCRIPT__', 'getDefaultServices', { hotelId: hotelId, bookingRoomId: bookingRoomId });
    if (!result || !result.services || !result.services.length) return;

    for (var i = 0; i < result.services.length; i++) {
        var svc = result.services[i];
        var uidResp = await callServerMethod('drive_api', 'getNewUID', { tableName: 'booking_room_services' });
        existingRows.push({
            UID: uidResp && uidResp.uid,
            bookingRoomId: bookingRoomId,
            serviceId: svc.serviceId,
            __serviceId_display: svc.serviceName,
            count: false
        });
    }

    svcTbl.data_updateValue(svcTbl.dataKey, existingRows);
    try { if (typeof svcTbl._invokeRenderBodyRows === 'function') svcTbl._invokeRenderBodyRows(); } catch(_) {}
    try { if (typeof form.setModified === 'function') form.setModified(true); } catch(_) {}
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
