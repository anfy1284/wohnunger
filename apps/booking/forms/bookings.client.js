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

// Вызывается при ВЫБОРЕ (или перевыборе) номера в ячейке таблицы номеров
// (колоночное событие onChange колонки roomId). Переформировывает ТЧ услуг
// для этого номера: убирает прежние услуги номера и добавляет дефолтные услуги
// отеля заново. Флаг "включено" каждой услуги берётся из реквизита услуги
// includeByDefault. Срабатывает ТОЛЬКО при выборе комнаты, не при простой
// активации строки.
//   rowIndex   — индекс строки номера в этой таблице
//   newVal     — выбранный roomId (UID комнаты)
//   displayVal — отображаемое имя комнаты
async function onRoomSelected(rowIndex, newVal, displayVal, ctx) {
    var form = ctx.form;

    var roomsTbl = form.controlsMap && form.controlsMap['ts_booking_rooms'];
    if (!roomsTbl) return;
    var roomRows = roomsTbl.data_getRows(roomsTbl.dataKey);
    var activeRoom = roomRows[rowIndex];
    if (!activeRoom || !activeRoom.UID) return;
    var bookingRoomId = activeRoom.UID;

    // Комната снята (значение очищено) — ничего не формируем.
    var roomId = newVal || activeRoom.roomId;
    if (!roomId) return;

    var hotelEntry = form._dataMap && form._dataMap['hotelId'];
    var hotelId = hotelEntry && hotelEntry.value;
    if (!hotelId) return;

    var svcTbl = form.controlsMap && form.controlsMap['ts_booking_room_services'];
    if (!svcTbl) return;
    var rows = svcTbl.data_getRows(svcTbl.dataKey);

    // Переформирование: убираем прежние услуги ЭТОГО номера НА МЕСТЕ (splice),
    // сохраняя ссылку на массив. Замыкание renderBodyRows захватывает массив строк
    // по ссылке — если подменить его новым (через .filter()), рендер и последующий
    // "Add" ломаются (рисуется старый массив, данные пишутся в новый). Поэтому
    // только in-place мутация, как в штатном doToolbarAction('recordAdd').
    for (var k = rows.length - 1; k >= 0; k--) {
        if (rows[k] && rows[k].bookingRoomId === bookingRoomId) rows.splice(k, 1);
    }

    var result = await callServer('__SERVER_SCRIPT__', 'getDefaultServices', { hotelId: hotelId, bookingRoomId: bookingRoomId, force: true });
    if (result && result.services && result.services.length) {
        for (var i = 0; i < result.services.length; i++) {
            var svc = result.services[i];
            var uidResp = await callServerMethod('drive_api', 'getNewUID', { tableName: 'booking_room_services' });
            rows.push({
                UID: uidResp && uidResp.uid,
                bookingRoomId: bookingRoomId,
                serviceId: svc.serviceId,
                __serviceId_display: svc.serviceName,
                included: !!svc.includeByDefault,
                count: 1
            });
        }
    }

    svcTbl.data_updateValue(svcTbl.dataKey, rows);
    try { if (typeof svcTbl._invokeRenderBodyRows === 'function') svcTbl._invokeRenderBodyRows(); } catch(_) {}
    try { if (typeof form.setModified === 'function') form.setModified(true); } catch(_) {}
}

// Вызывается при активации строки в таблице доп.услуг.
// Если в строке ещё не выбрана налоговая ставка — подставляет ставку по умолчанию
// из настроек организации (organizationSettings → defaultTaxRate).
async function onExtraLineActivated(rowIndex, ctx) {
    var form = ctx.form;
    var tbl = form.controlsMap && form.controlsMap['ts_booking_extra_lines'];
    if (!tbl) return;
    var rows = tbl.data_getRows(tbl.dataKey);
    var row = rows[rowIndex];
    if (!row) return;
    if (row.taxRateId) return; // ставка уже задана — не трогаем

    var orgEntry = form._dataMap && form._dataMap['organizationId'];
    var organizationId = orgEntry && orgEntry.value;

    var result = await callServer('__SERVER_SCRIPT__', 'getOrgDefaultTaxRate', { organizationId: organizationId });
    if (!result || !result.taxRateId) return; // дефолт не настроен

    row.taxRateId = result.taxRateId;
    row.__taxRateId_display = result.taxRateName;
    tbl.data_updateValue(tbl.dataKey, rows);
    try { if (typeof tbl._invokeRenderBodyRows === 'function') tbl._invokeRenderBodyRows(); } catch(_) {}
    try { if (typeof form.setModified === 'function') form.setModified(true); } catch(_) {}
}

async function printInvoice(ev, ctx) {
    var form = ctx.form;
    var uidEntry = form._dataMap && form._dataMap['UID'];
    var bookingId = uidEntry && uidEntry.value;
    if (!bookingId) { showAlert(__t('Please save the booking first')); return; }

    // Если форма изменена — предложить сохранить (пересчёт счёта произойдёт автоматически в onBeforeSave).
    // Сам диалог-подтверждение показываем БЕЗ индикатора (ждём ответа пользователя).
    var needSave = false;
    if (form._modified) {
        var ok = await showConfirm(__t('Save before printing?'));
        if (!ok) return;
        needSave = true;
    }

    // Бегущий прогрессбар сразу после ответа «да» — закрывает и ощутимое
    // сохранение (round-trip + пересчёт счёта в onBeforeSave + refresh), и
    // последующую серверную генерацию счёта. Печать окна покрывается отдельно
    // индикатором внутри MySpace.open.
    var busyToken = (window.MySpace && window.MySpace.showBusy) ? window.MySpace.showBusy(__t('Preparing invoice…')) : null;
    var result;
    try {
        if (needSave) {
            await form.doAction('save');
            if (form._modified) return; // сохранение не удалось, ошибка уже показана
        }

        result = await callServer('reports.actions', 'generateInvoiceHTML', { bookingId: bookingId });
    } finally {
        if (busyToken != null && window.MySpace && window.MySpace.hideBusy) window.MySpace.hideBusy(busyToken);
    }
    if (result.error) { showAlert(__t('Error: ') + result.error); return; }

    if (window.MySpace && typeof window.MySpace.open === 'function') {
        await window.MySpace.open('printPreview', { html: result.html, autoPrint: true });
    }
}

return { onRoomSelected, onExtraLineActivated, printInvoice };
