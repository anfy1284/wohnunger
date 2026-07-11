// Клиентские функции формы "Счёт".
//
// Этот файл загружается как исходный текст через loadScript() в init.js.
// Плейсхолдер __SERVER_SCRIPT__ заменяется на реальное имя серверного скрипта при загрузке.
//
// Сигнатура обработчиков: function(eventArgs..., ctx)
//   ctx.form     — DataForm текущей формы
//   ctx.fnParams — параметры из лейаута (с резолвом {data.field})
//
// Файл должен заканчиваться return { ... } — этого требует loadScript().

// «Заполнить»: перезаполняет строки счёта из его броней (RPC fillInvoice).
// Ручные правки строк при этом теряются — предупреждаем. Несохранённая форма
// сначала сохраняется (ТЧ броней должна лежать в БД до серверного заполнения).
async function fillInvoice(ev, ctx) {
    var form = ctx.form;
    var uidEntry = form._dataMap && form._dataMap['UID'];
    var invoiceId = uidEntry && uidEntry.value;
    if (!invoiceId) { showAlert(__t('Please save the invoice first')); return; }

    var linesTbl = form.controlsMap && form.controlsMap['ts_invoice_lines'];
    var rows = linesTbl ? linesTbl.data_getRows(linesTbl.dataKey) : [];
    if (rows && rows.length) {
        var ok = await showConfirm(__t('refill_lines_warning'));
        if (!ok) return;
    }

    var busyToken = (window.MySpace && window.MySpace.showBusy) ? window.MySpace.showBusy(__t('Calculating…')) : null;
    var result;
    try {
        if (form.needsSave()) {
            await form.doAction('save');
            if (form.needsSave()) return; // сохранение не удалось, ошибка уже показана
        }
        result = await callServer('__SERVER_SCRIPT__', 'fillInvoice', { invoiceId: invoiceId });
    } finally {
        if (busyToken != null && window.MySpace && window.MySpace.hideBusy) window.MySpace.hideBusy(busyToken);
    }
    if (!result || result.error) { showAlert(__t('Error: ') + (result && result.error || '')); return; }

    // Применяем результат на форму: строки ТЧ (in-place, сохраняя ссылку на массив —
    // см. паттерн onRoomSelected в booking) + prepayment. Данные уже в БД,
    // поэтому форма после применения — «чистая».
    if (linesTbl) {
        var arr = linesTbl.data_getRows(linesTbl.dataKey);
        arr.splice(0, arr.length);
        var fresh = result.lines || [];
        for (var i = 0; i < fresh.length; i++) arr.push(fresh[i]);
        linesTbl.data_updateValue(linesTbl.dataKey, arr);
        try { if (typeof linesTbl._invokeRenderBodyRows === 'function') linesTbl._invokeRenderBodyRows(); } catch(_) {}
    }
    try {
        var setField = function (name, val) {
            var c = form.controlsMap && form.controlsMap[name];
            if (c && typeof c.setValue === 'function') { try { c.setValue(val); } catch (e) {} }
            if (form._dataMap && form._dataMap[name]) form._dataMap[name].value = val;
        };
        if (result.invoice) {
            setField('prepayment', result.invoice.prepayment);
            // Скидка могла быть перенесена/агрегирована из броней — обновляем поля формы.
            setField('discountValue', result.invoice.discountValue);
            setField('discountMode', result.invoice.discountMode);
        }
    } catch(_) {}
    try { if (typeof form.setModified === 'function') form.setModified(false); } catch(_) {}

    // Разные скидки в нескольких бронях-основаниях объединены — предупреждаем.
    if (result.discountNotice) { try { showAlert(result.discountNotice); } catch(_) {} }
}

// «Печать»: сохранить (если изменено) → серверная генерация HTML → printPreview.
// Паттерн printInvoice из брони, но по invoiceId.
async function printInvoice(ev, ctx) {
    var form = ctx.form;
    var uidEntry = form._dataMap && form._dataMap['UID'];
    var invoiceId = uidEntry && uidEntry.value;
    if (!invoiceId) { showAlert(__t('Please save the invoice first')); return; }

    var needSave = false;
    if (form.needsSave()) {
        var ok = await showConfirm(__t('Save before printing?'));
        if (!ok) return;
        needSave = true;
    }

    var busyToken = (window.MySpace && window.MySpace.showBusy) ? window.MySpace.showBusy(__t('Preparing invoice…')) : null;
    var result;
    try {
        if (needSave) {
            await form.doAction('save');
            if (form.needsSave()) return; // сохранение не удалось, ошибка уже показана
        }
        result = await callServer('reports.actions', 'generateInvoiceHTML', { invoiceId: invoiceId });
    } finally {
        if (busyToken != null && window.MySpace && window.MySpace.hideBusy) window.MySpace.hideBusy(busyToken);
    }
    if (result.error) { showAlert(__t('Error: ') + result.error); return; }

    if (window.MySpace && typeof window.MySpace.open === 'function') {
        await window.MySpace.open('printPreview', { html: result.html, autoPrint: true });
    }
}

// Колоночное событие onChange количества/цены: живой пересчёт amount строки
// (авторитетный пересчёт — на сервере в onBeforeSave).
function onLineQtyOrPriceEdited(rowIndex, newVal, displayVal, ctx) {
    var form = ctx.form;
    var tbl = form.controlsMap && form.controlsMap['ts_invoice_lines'];
    if (!tbl) return;
    var rows = tbl.data_getRows(tbl.dataKey);
    var row = rows && rows[rowIndex];
    if (!row) return;
    var qty = Number(row.quantity);
    var unit = Number(row.unitPrice);
    if (!isFinite(qty) || !isFinite(unit)) return;
    var amount = Math.round(qty * unit * 100) / 100;
    row.amount = amount;
    // Точечное обновление ячейки суммы (без перерисовки всей ТЧ — не терять фокус).
    var cellKey = tbl.dataKey + '__r' + rowIndex + '__amount';
    var cell = form.controlsMap && form.controlsMap[cellKey];
    if (cell && typeof cell.setValue === 'function') {
        try { cell.setValue(amount); } catch (e) {}
    }
    try { tbl.data_updateValue(cellKey, amount); } catch (e) {}
}

return { fillInvoice, printInvoice, onLineQtyOrPriceEdited };
