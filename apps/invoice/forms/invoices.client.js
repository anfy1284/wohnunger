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
    // Услуги брони, не попавшие в счёт (нет цены / начисляются автоматически).
    // Раньше они исчезали молча — счёт недосчитывался денег без единого признака.
    if (result.skippedNotice) { try { showAlert(result.skippedNotice); } catch(_) {} }
}

// Колоночное событие onChange колонки «Услуга» в спецификации счёта: подставляет
// в РУЧНУЮ строку название, цену из прайс-листа и ставку НДС услуги. Без этого
// строка оставалась с пустой ценой/ставкой и уходила в счёт нулём.
async function onLineServiceSelected(rowIndex, newVal, displayVal, ctx) {
    var form = ctx.form;
    var tbl = form.controlsMap && form.controlsMap['ts_invoice_lines'];
    if (!tbl || !newVal) return;
    var rows = tbl.data_getRows(tbl.dataKey);
    var row = rows && rows[rowIndex];
    if (!row) return;

    var uidEntry = form._dataMap && form._dataMap['UID'];
    var res = await callServer('__SERVER_SCRIPT__', 'getServiceLineDefaults', {
        invoiceId: uidEntry && uidEntry.value,
        serviceId: newVal
    });
    if (!res || res.error) return;

    if (!row.label) row.label = res.label || '';
    if (!row.sectionLabel) row.sectionLabel = res.sectionLabel || '';
    if (res.taxRateId && !row.taxRateId) {
        row.taxRateId = res.taxRateId;
        row.__taxRateId_display = res.taxRateName;
    }
    if (res.taxCategoryId && !row.taxCategoryId) row.taxCategoryId = res.taxCategoryId;
    if (res.unitPrice != null && !Number(row.unitPrice)) row.unitPrice = res.unitPrice;
    if (!Number(row.quantity)) row.quantity = 1;
    var qty = Number(row.quantity), unit = Number(row.unitPrice);
    // Округление — общее с сервером (MySpace.money), иначе форма покажет
    // одну сумму, а сохранится другая.
    if (isFinite(qty) && isFinite(unit)) row.amount = MySpace.money.mul(row.unitPrice, qty);

    tbl.data_updateValue(tbl.dataKey, rows);
    try { if (typeof tbl._invokeRenderBodyRows === 'function') tbl._invokeRenderBodyRows(); } catch(_) {}
    try { if (typeof form.setModified === 'function') form.setModified(true); } catch(_) {}

    // Цены в прайс-листе нет — говорим вслух, иначе пользователь увидит пустую
    // цену и решит, что программа «не подтягивает». Отдельный случай: цена у услуги
    // РАЗНАЯ по квартирам, а счёт охватывает не одну квартиру — угадывать нельзя,
    // молчаливая подстановка чужой цены хуже пустого поля.
    if (res.noPrice) {
        try { showAlert(__t(res.priceIssue === 'ambiguous' ? 'service_price_room_specific_alert' : 'service_no_price_alert')); } catch(_) {}
    }
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

    // autoPrint: printPreview не открывает своё окно, а сразу зовёт window.print()
    // в скрытом iframe — пользователь получает штатное окно предпросмотра печати
    // браузера в один клик. Решение владельца (2026-07-29): собственное окно
    // предпросмотра для ERP уместно, но пока преждевременно, а промежуточный шаг
    // стоил лишнего нажатия. Вернуть его можно будет, когда оно будет сделано по
    // правилам проекта — управление в командной панели сверху, переводы, иконки
    // (бэклог B4). Для агентов-тестировщиков системное окно печати блокирует
    // расширение браузера — это ограничение стенда, не продукта.
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
    var amount = MySpace.money.mul(row.unitPrice, qty);
    // Запись через штатный API строки: он же обновляет итоговую строку ТЧ.
    try { tbl.data_updateParentArray(tbl.dataKey, rowIndex, { data: 'amount' }, amount); } catch (e) { row.amount = amount; }
    // Точечное обновление ячейки суммы (без перерисовки всей ТЧ — не терять фокус).
    var cellKey = tbl.dataKey + '__r' + rowIndex + '__amount';
    var cell = form.controlsMap && form.controlsMap[cellKey];
    if (cell && typeof cell.setValue === 'function') {
        try { cell.setValue(amount); } catch (e) {}
    }
    try { tbl.data_updateValue(cellKey, amount); } catch (e) {}
}

// Записать значение в поле формы. DataForm.doAction умеет только
// runScript/ok/save/cancel — команды «обновить» у него нет, и после серверной
// смены статуса форма иначе продолжает показывать «Entwurf».
//
// Идём через setControlValue, а не в controlsMap напрямую: это штатный путь, и
// на смене поля состояния он запирает форму и пересчитывает доступность кнопок.
// Прямая запись в контрол оставила бы выставленный счёт редактируемым до
// повторного открытия окна.
function _setFormField(form, name, val) {
    if (typeof form.setControlValue === 'function' && form.setControlValue(name, val)) return;
    var c = form.controlsMap && form.controlsMap[name];
    if (c && typeof c.setValue === 'function') { try { c.setValue(val); } catch (e) {} }
    if (form._dataMap && form._dataMap[name]) form._dataMap[name].value = val;
}

// ── «Выставить» / «Выставить и напечатать» ───────────────────────────────
//
// Момент неизменности — эта команда, а не печать: счёт считается выставленным,
// когда покинул сферу выставителя. После неё счёт правке не подлежит (запрет
// стоит в ядре, в dbGateway), поэтому спрашиваем подтверждение.
async function _issue(ctx, withPrint) {
    var form = ctx.form;
    var uidEntry = form._dataMap && form._dataMap['UID'];
    var invoiceId = uidEntry && uidEntry.value;
    if (!invoiceId) { showAlert(__t('Please save the invoice first')); return; }

    var ok = await showConfirm(__t('issue_invoice_confirm'));
    if (!ok) return;

    var busyToken = (window.MySpace && window.MySpace.showBusy) ? window.MySpace.showBusy(__t('Preparing invoice…')) : null;
    var result;
    try {
        if (form.needsSave()) {
            await form.doAction('save');
            if (form.needsSave()) return; // сохранение не удалось, ошибка уже показана
        }
        result = await callServer('__SERVER_SCRIPT__', 'issueInvoice', {
            invoiceId: invoiceId, print: !!withPrint
        });
    } finally {
        if (busyToken != null && window.MySpace && window.MySpace.hideBusy) window.MySpace.hideBusy(busyToken);
    }
    if (!result || result.error) { showAlert(__t('Error: ') + (result && result.error || '')); return; }

    // Счёт выставлен, но копия в архив не легла — сказать вслух: печать такого
    // счёта пойдёт живой сборкой, а она со временем разойдётся с выданным.
    if (result.archiveError) { try { showAlert(__t('invoice_archive_failed') + ' ' + result.archiveError); } catch(_) {} }

    if (withPrint && result.html && window.MySpace && typeof window.MySpace.open === 'function') {
        await window.MySpace.open('printPreview', { html: result.html, autoPrint: true });
    }

    // Статус изменился на сервере — показываем это на форме. Данные уже в базе,
    // поэтому форма после подстановки считается чистой.
    _setFormField(form, 'status', result.status || 'issued');
    if (result.issuedAt) _setFormField(form, 'issuedAt', result.issuedAt);
    try { if (typeof form.setModified === 'function') form.setModified(false); } catch(_) {}
}

async function issueInvoice(ev, ctx)         { return await _issue(ctx, false); }
async function issueAndPrintInvoice(ev, ctx) { return await _issue(ctx, true); }

// ── «Сторнировать» ───────────────────────────────────────────────────────
//
// Выставленный счёт исправлять нельзя. Сторно — встречный документ со своим
// номером и обратными знаками; исходный уходит в «отменён». Открываем сторно
// сразу после создания: пользователю нужен его номер.
async function stornoInvoice(ev, ctx) {
    var form = ctx.form;
    var uidEntry = form._dataMap && form._dataMap['UID'];
    var invoiceId = uidEntry && uidEntry.value;
    if (!invoiceId) { showAlert(__t('Please save the invoice first')); return; }

    var ok = await showConfirm(__t('storno_invoice_confirm'));
    if (!ok) return;

    var busyToken = (window.MySpace && window.MySpace.showBusy) ? window.MySpace.showBusy(__t('Preparing invoice…')) : null;
    var result;
    try {
        result = await callServer('__SERVER_SCRIPT__', 'stornoInvoice', { invoiceId: invoiceId });
    } finally {
        if (busyToken != null && window.MySpace && window.MySpace.hideBusy) window.MySpace.hideBusy(busyToken);
    }
    if (!result || result.error) { showAlert(__t('Error: ') + (result && result.error || '')); return; }

    showAlert(__t('storno_created') + ' ' + (result.stornoNumber || ''));

    // Открываем сторно-документ отдельным окном.
    if (result.stornoId && window.MySpace && typeof window.MySpace.open === 'function') {
        // Параметры окна записи — tableName/recordID (как в bookings.client.js).
        // dbTable/UID uniForm не понимает: окно открывается пустым.
        await window.MySpace.open('uniForm', {
            mode: 'record', tableName: 'invoices', recordID: result.stornoId
        });
    }
    // Исходный счёт сервер перевёл в «отменён» — показываем это сразу.
    _setFormField(form, 'status', 'cancelled');
    try { if (typeof form.setModified === 'function') form.setModified(false); } catch(_) {}
}

return { fillInvoice, printInvoice, onLineQtyOrPriceEdited, onLineServiceSelected,
         issueInvoice, issueAndPrintInvoice, stornoInvoice };
