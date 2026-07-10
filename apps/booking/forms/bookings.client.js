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
                // autoQuantity = есть ли у услуги формула: непустая → авторасчёт по формуле,
                // пустая → ручное количество (1). Сам count для формульных строк проставит
                // пересчёт по событию изменения формы (onFormChange ниже).
                autoQuantity: !!svc.hasFormula,
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

// Form-level событие «при изменении» (events.onChange формы): пересчитывает
// количества услуг по формуле. Перерасчёт ВЕСЬ на сервере (единый источник —
// formulaEngine + реестр переменных): шлём текущие строки ТЧ + даты, получаем
// обновлённые { count, autoQuantity } и применяем. Дебаунс события — в setModified.
async function onFormChange(ctx) {
    var form = ctx.form;
    var svcTbl = form.controlsMap && form.controlsMap['ts_booking_room_services'];
    if (!svcTbl) return;
    var rows = svcTbl.data_getRows(svcTbl.dataKey);
    if (!rows || !rows.length) return;

    // Защита от наложения запросов: если перерасчёт уже идёт — пометим, что нужен ещё один.
    if (form._recalcInFlight) { form._recalcPending = true; return; }

    var ciEntry = form._dataMap && form._dataMap['checkIn'];
    var coEntry = form._dataMap && form._dataMap['checkOut'];
    var checkIn = ciEntry && ciEntry.value;
    var checkOut = coEntry && coEntry.value;

    var payload = rows.map(function(r) {
        return { UID: r.UID, serviceId: r.serviceId, autoQuantity: r.autoQuantity !== false, count: r.count };
    });

    form._recalcInFlight = true;
    var result;
    try {
        result = await callServer('__SERVER_SCRIPT__', 'recalcServiceQuantities', { checkIn: checkIn, checkOut: checkOut, roomServices: payload });
    } finally {
        form._recalcInFlight = false;
    }

    if (result && result.rows) {
        var byUID = {};
        for (var i = 0; i < result.rows.length; i++) byUID[result.rows[i].UID] = result.rows[i];

        var changed = false;
        for (var k = 0; k < rows.length; k++) {
            var upd = byUID[rows[k].UID];
            if (!upd) continue;
            if (rows[k].count !== upd.count) { rows[k].count = upd.count; changed = true; }
            var oldAuto = rows[k].autoQuantity !== false;
            var newAuto = upd.autoQuantity !== false;
            if (oldAuto !== newAuto) { rows[k].autoQuantity = newAuto; changed = true; }
        }

        if (changed) {
            // _suppressFormChange защищает от рекурсии: setModified ниже не должен
            // повторно дёрнуть onChange.
            form._suppressFormChange = true;
            try {
                svcTbl.data_updateValue(svcTbl.dataKey, rows);
                if (typeof svcTbl._invokeRenderBodyRows === 'function') svcTbl._invokeRenderBodyRows();
                if (typeof form.setModified === 'function') form.setModified(true);
            } finally {
                form._suppressFormChange = false;
            }
        }
    }

    // За время запроса могли прийти новые изменения — перезапустим перерасчёт.
    if (form._recalcPending) { form._recalcPending = false; setTimeout(function() { onFormChange(ctx); }, 0); }
}

// Колоночное событие onChange колонки "количество": ручной ввод количества
// отключает автопересчёт для этой строки (autoQuantity = false), чтобы следующий
// перерасчёт не затёр введённое значение.
function onServiceCountEdited(rowIndex, newVal, displayVal, ctx) {
    var form = ctx.form;
    var svcTbl = form.controlsMap && form.controlsMap['ts_booking_room_services'];
    if (!svcTbl) return;
    var rows = svcTbl.data_getRows(svcTbl.dataKey);
    var row = rows && rows[rowIndex];
    if (!row) return;
    row.autoQuantity = false;
    // Снимаем галочку автоколичества СРАЗУ (точечно, без перерисовки всей ТЧ —
    // чтобы не терять фокус/спиннер активной ячейки). Ближайший перерасчёт уже не
    // увидит изменения (autoQuantity уже false), поэтому он галочку не перерисует.
    // Чекбокс ячейки зарегистрирован в controlsMap по ключу dataKey + '__r<i>__autoQuantity'.
    var cbKey = svcTbl.dataKey + '__r' + rowIndex + '__autoQuantity';
    var cb = form.controlsMap && form.controlsMap[cbKey];
    if (cb && typeof cb.setChecked === 'function') {
        try { cb.setChecked(false); } catch (e) {}
    }
    // Синхронизируем значение ячейки в датасете — иначе ближайшая перерисовка тела ТЧ
    // (_invokeRenderBodyRows при пересчёте count) перечитает старое true и вернёт галочку.
    try { svcTbl.data_updateValue(cbKey, false); } catch (e) {}
}

// ── Адаптивная кнопка счёта (splitButton btnInvoice в commandBar) ─────────
//
// Состояние кнопки питается данными вкладки «Счета» (relatedList relInvoices):
// её onDataRefreshed срабатывает и на первичной загрузке формы, и на каждом
// SSE-refresh (счёт создан/удалён в этом или ДРУГОМ окне) — без второго RPC.
//   Счетов нет  → [ Создать счёт ]            (меню пусто, стрелка скрыта)
//   Счета есть  → [ Открыть счёт №N | ▾ ]     (меню: все счета + «Создать новый»)

var ICON_INVOICE = '/apps/booking_icons/resources/public/16x16/invoice.png';
var ICON_NEW     = '/apps/general_icons/resources/public/16x16/document_new.png';

function _fmtInvoiceDate(v) {
    if (!v) return '';
    var dt = new Date(v);
    if (isNaN(dt.getTime())) return String(v);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(dt.getDate()) + '.' + p(dt.getMonth() + 1) + '.' + dt.getFullYear();
}

// Открыть форму записи счёта (как двойной клик списка: uniForm, mode record).
async function _openInvoiceRecord(invoiceUID) {
    if (window.MySpace && typeof window.MySpace.open === 'function') {
        await window.MySpace.open('uniForm', { mode: 'record', tableName: 'invoices', recordID: invoiceUID });
    }
}

// Создать счёт из текущей брони: сохранить форму (если изменена) → RPC → открыть.
// Обновление кнопки/вкладки «Счета» придёт само по SSE (createFromBooking шлёт
// dataChanged) — руками ничего не перечитываем.
async function _createInvoiceFromBooking(form) {
    if (form._modified) {
        await form.doAction('save');
        if (form._modified) return; // сохранение не удалось, ошибка уже показана
    }
    var uidEntry = form._dataMap && form._dataMap['UID'];
    var bookingId = uidEntry && uidEntry.value;
    if (!bookingId) { showAlert(__t('Please save the booking first')); return; }

    var busyToken = (window.MySpace && window.MySpace.showBusy) ? window.MySpace.showBusy(__t('Preparing invoice…')) : null;
    var result;
    try {
        result = await callServer('invoice.actions', 'createFromBooking', { bookingId: bookingId });
    } finally {
        if (busyToken != null && window.MySpace && window.MySpace.hideBusy) window.MySpace.hideBusy(busyToken);
    }
    if (!result || result.error) { showAlert(__t('Error: ') + (result && result.error || '')); return; }
    await _openInvoiceRecord(result.invoiceId);
}

// Основной сегмент кнопки: счета есть → открыть последний, нет → создать.
async function invoiceButtonClick(ev, ctx) {
    var form = ctx.form;
    var invoices = form._bookingInvoices || [];
    if (invoices.length) {
        await _openInvoiceRecord(invoices[0].UID);
    } else {
        await _createInvoiceFromBooking(form);
    }
}

// Колбэк relatedList (events.onDataRefreshed): перечитывает состояние кнопки
// из уже загруженных данных списка. tbl — сам DynamicTable вкладки «Счета».
function onInvoicesRefreshed(tbl, ctx) {
    var form = ctx.form;
    var btn = form.controlsMap && form.controlsMap['btnInvoice'];
    if (!btn) return;

    // Собираем загруженные строки (журнал счетов брони короткий — первый экран).
    var rows = [];
    try {
        var cache = tbl && tbl.dataCache ? tbl.dataCache : {};
        for (var k in cache) {
            if (cache[k] && cache[k].loaded) rows.push(cache[k]);
        }
    } catch (_) {}
    rows.sort(function (a, b) { return new Date(b.date || 0) - new Date(a.date || 0); });
    form._bookingInvoices = rows;

    if (!rows.length) {
        btn.setCaption(__t('create_invoice_btn'));
        if (typeof btn.setMenu === 'function') btn.setMenu([]);
        return;
    }

    var latest = rows[0];
    btn.setCaption(__t('open_invoice_btn').replace('{number}', latest.number || ''));

    var menu = [];
    if (rows.length > 1) {
        rows.forEach(function (inv) {
            menu.push({
                caption: __t('invoice_menu_item')
                    .replace('{number}', inv.number || '')
                    .replace('{date}', _fmtInvoiceDate(inv.date)),
                icon: ICON_INVOICE,
                onClick: function () { _openInvoiceRecord(inv.UID); }
            });
        });
        menu.push({ separator: true });
    }
    // «Создать новый счёт» из меню — явное информированное намерение,
    // предупреждающий диалог не нужен.
    menu.push({
        caption: __t('create_new_invoice_menu'),
        icon: ICON_NEW,
        onClick: function () { _createInvoiceFromBooking(form); }
    });
    if (typeof btn.setMenu === 'function') btn.setMenu(menu);
}

return { onRoomSelected, onExtraLineActivated, onFormChange, onServiceCountEdited, invoiceButtonClick, onInvoicesRefreshed };
