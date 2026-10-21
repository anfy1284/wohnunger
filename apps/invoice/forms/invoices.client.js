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
    return _fillInvoice(ctx, false);
}

// Изменилась табличная часть «Buchungen» (бронь выбрана, заменена или строка
// удалена) — строки счёта больше не соответствуют его броням. Предлагаем
// перезаполнить тем же «Ausfüllen»; ОДИН вопрос вместо двух — он уже говорит, что
// строки будут собраны заново (ручные правки строк при этом теряются).
// Только у черновика: выставленный счёт не перезаполняется вовсе.
var _bookingsChangedTimer = null;
function onBookingsChanged(a, b, c, ctx) {
    // Сигнатуры разные: колоночное onChange — (rowIndex, newVal, display, ctx),
    // onRowDeleted — (row, ctx). ctx всегда последний.
    var args = Array.prototype.slice.call(arguments);
    var context = args[args.length - 1];
    var form = context && context.form;
    if (!form) return;
    // Счёт «на основании брони» только что собран из этих броней — ядро прогоняет
    // обработчики по предзаполненным строкам, и вопрос был бы бессмысленным.
    if (form._firingPrefilled) return;
    var status = form.getControlValue ? form.getControlValue('status') : null;
    if (status && status !== 'draft') return;
    // Выбор брони в ячейке шлёт событие и на пустое значение (очистка поля) —
    // спрашивать тогда не о чем, перезаполнять тоже.
    if (args.length === 4 && (args[1] === null || args[1] === undefined || args[1] === '')) return;
    // Серия правок подряд (удалил одну строку, выбрал другую бронь) — один вопрос.
    if (_bookingsChangedTimer) clearTimeout(_bookingsChangedTimer);
    _bookingsChangedTimer = setTimeout(async function () {
        _bookingsChangedTimer = null;
        var ok = await showConfirm(__t('invoice_bookings_changed_refill'));
        if (ok) await _fillInvoice(context, true);
    }, 300);
}

async function _fillInvoice(ctx, confirmed) {
    var form = ctx.form;
    var uidEntry = form._dataMap && form._dataMap['UID'];
    var invoiceId = uidEntry && uidEntry.value;
    if (!invoiceId) { showAlert(__t('Please save the invoice first')); return; }

    var linesTbl = form.controlsMap && form.controlsMap['ts_invoice_lines'];
    var rows = linesTbl ? linesTbl.data_getRows(linesTbl.dataKey) : [];
    if (!confirmed && rows && rows.length) {
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
        }
        // Скидки броней легли в строки «Buchungen» — показать их.
        var bkTbl = form.controlsMap && form.controlsMap['ts_invoice_bookings'];
        if (bkTbl && Array.isArray(result.bookings)) {
            var bArr = bkTbl.data_getRows(bkTbl.dataKey);
            for (var j = 0; j < bArr.length; j++) {
                var upd = result.bookings.find(function (b) { return b.UID === bArr[j].UID || b.bookingId === bArr[j].bookingId; });
                if (upd) { bArr[j].discountValue = upd.discountValue; bArr[j].discountMode = upd.discountMode; }
            }
            bkTbl.data_updateValue(bkTbl.dataKey, bArr);
            try { if (typeof bkTbl._invokeRenderBodyRows === 'function') bkTbl._invokeRenderBodyRows(); } catch(_) {}
        }
    } catch(_) {}
    try { if (typeof form.setModified === 'function') form.setModified(false); } catch(_) {}
    refreshPayable(ctx);

    // Услуги брони, не попавшие в счёт (нет цены / начисляются автоматически).
    // Раньше они исчезали молча — счёт недосчитывался денег без единого признака.
    if (result.skippedNotice) { try { showAlert(result.skippedNotice); } catch(_) {} }
    // Часть услуг (или все) уже выставлены другим счётом — в этот они не попали.
    // Это нормальный исход, но без слов он выглядит в точности как сбой расчёта:
    // нажал «Заполнить», а строк нет.
    if (result.alreadyNotice) { try { showAlert(result.alreadyNotice); } catch(_) {} }
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
    refreshPayable(ctx);
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
    recalcLineAmount('ts_invoice_lines', rowIndex, ctx);
    refreshPayable(ctx);
}

// То же для вкладки «Wie es sein soll» корректировки: строки «как должно быть»
// раньше не пересчитывались до сохранения — 420,00 при Anz. 2 (прогон 17.10.2026, E6).
// «Zu zahlen» корректировки — разница с выставленным, её считает сервер при сохранении.
function onTargetLineQtyOrPriceEdited(rowIndex, newVal, displayVal, ctx) {
    recalcLineAmount('ts_invoice_target_lines', rowIndex, ctx);
}

function recalcLineAmount(tableName, rowIndex, ctx) {
    var form = ctx.form;
    var tbl = form.controlsMap && form.controlsMap[tableName];
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

// ── «Сумма к оплате» на форме ────────────────────────────────────────────
//
// Число СЧИТАЕТ СЕРВЕР (метод формы `payable`), клиент только показывает.
// Своего расчёта здесь быть не должно: скидка не распространяется на
// durchlaufender Posten (курортный сбор), а это признак справочника налоговых
// групп — вторая копия правила в браузере разошлась бы с печатью, причём молча
// и в деньгах.
//
// Запрос с задержкой: при наборе количества событие приходит на каждую цифру,
// и спрашивать сервер столько же раз незачем. Ответ применяется только если он
// последний — иначе медленный ранний ответ перезаписал бы свежий.
var _payableTimer = null;
var _payableSeq = 0;

function refreshPayable(ctx) {
    var form = ctx && ctx.form;
    if (!form || typeof form.callMethod !== 'function') return;
    if (_payableTimer) clearTimeout(_payableTimer);
    _payableTimer = setTimeout(async function () {
        _payableTimer = null;
        var seq = ++_payableSeq;
        try {
            var tbl = form.controlsMap && form.controlsMap['ts_invoice_lines'];
            var rows = (tbl && tbl.data_getRows(tbl.dataKey)) || [];
            var lines = rows.map(function (r) {
                return { amount: r.amount, taxCategoryId: r.taxCategoryId, bookingId: r.bookingId };
            });
            // Скидки броней — из строк ТЧ «Buchungen» (действуют на строки своей брони).
            var bkTbl = form.controlsMap && form.controlsMap['ts_invoice_bookings'];
            var bookings = ((bkTbl && bkTbl.data_getRows(bkTbl.dataKey)) || []).map(function (b) {
                return { bookingId: b.bookingId, discountMode: b.discountMode, discountValue: b.discountValue };
            });
            var val = function (name) {
                var e = form._dataMap && form._dataMap[name];
                return e ? e.value : null;
            };
            var res = await form.callMethod('payable', {
                lines: lines,
                discountMode: val('discountMode'),
                discountValue: val('discountValue'),
                prepayment: val('prepayment'),
                bookings: bookings
            });
            if (seq !== _payableSeq) return;          // пришёл не последний ответ
            if (!res || res.payableAmount === undefined) return;
            form.setControlValue('payableAmount', res.payableAmount);
        } catch (e) {
            console.error('[invoice] сумма к оплате не пересчитана:', e && e.message);
        }
    }, 250);
}

/** Правка предоплаты или скидки — то же число меняется (события лейаута). */
function onTotalsFieldChanged(newVal, displayVal, ctx) {
    refreshPayable(ctx);
}

/** Скидка брони в строке ТЧ «Buchungen» (колоночное событие: номер строки первым). */
function onBookingDiscountEdited(rowIndex, newVal, displayVal, ctx) {
    refreshPayable(ctx);
}

// `_setFormField` удалён вместе с собственным выставлением счёта: состояние формы
// после проведения выставляет ЯДРО (`watchPosting` → `setControlValue`), и второй
// путь подстановки значений разошёлся бы с первым.


// ── «Выставить» / «Выставить и напечатать» ───────────────────────────────
//
// «Выставить» здесь БОЛЬШЕ НЕТ: для счёта «выставлен» = «проведён», и кнопка стала
// ядровой командой `post` (объявлена в лейауте, обработчик — `invoice.postIssue`).
// Вместе с ней ядро взяло на себя подтверждение, сохранение несохранённого, замок
// формы на время проведения и приписку «в очереди» / «проводится» в заголовке.
// Переписывать это в приложении незачем и вредно: разойдётся.
//
// Приложению остаётся ПЕЧАТЬ — она его дело, а не ядра. Отсюда вся конструкция
// ниже: кнопка зовёт ту же ядровую команду и запоминает, что просили напечатать;
// печатает — событие `onPostingFinished`, когда архивная копия уже снята. Иначе
// пришлось бы печатать живой сборкой, а она со временем разойдётся с тем
// документом, который клиент получил на руки.
var _printAfterIssue = false;

async function issueAndPrintInvoice(ev, ctx) {
    _printAfterIssue = true;
    try {
        // Текст переспроса НЕ передаём: он объявлен у команды проведения
        // (`entityConfig.posting.confirm`), и эта кнопка обязана спросить ровно
        // то же, что спрашивает «Выставить». Своя копия текста здесь однажды
        // разошлась бы с объявленной.
        //
        // Команда вернула «не поехало» (отказ в переспросе, несохранённое не
        // записалось) — намерение печатать снимаем. Иначе оно переживёт отказ и
        // напечатает счёт при следующем проведении, о котором никто не просил.
        const went = await ctx.form.runDocumentCommand('post');
        if (!went) _printAfterIssue = false;
    } catch (e) {
        _printAfterIssue = false;
        throw e;
    }
}

/**
 * Проведение закончилось (событие формы `onPostingFinished`).
 * Печатаем только если просили и только успешное выставление: у неудачи печатать
 * нечего, а молча напечатать черновик вместо счёта — хуже, чем не напечатать.
 */
async function onPostingFinished(info, ctx) {
    if (!_printAfterIssue) return;
    _printAfterIssue = false;
    if (!info || info.status !== 'issued') return;
    try {
        await printInvoice(null, ctx);
    } catch (e) {
        console.error('[invoice] печать после выставления:', e && e.message);
    }
}

// «Сторнировать» и «Скорректировать» здесь НЕТ намеренно: это команды ядра,
// кнопки объявлены в лейауте как `"command": "storno" | "correct"`
// (drive_root/db/documentCommands.js + DataForm.runDocumentCommand).
return { fillInvoice, printInvoice, onLineQtyOrPriceEdited, onTargetLineQtyOrPriceEdited, onLineServiceSelected,
         issueAndPrintInvoice, onPostingFinished, onTotalsFieldChanged, onBookingDiscountEdited,
         onBookingsChanged };
