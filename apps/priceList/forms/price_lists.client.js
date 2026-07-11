// Клиентские функции формы «Прайс-лист».
//
// Этот файл загружается как исходный текст через loadScript() в init.js.
// Серверных вызовов своего скрипта нет — печать идёт через 'reports.actions'
// (как printInvoice в apps/invoice), поэтому плейсхолдер __SERVER_SCRIPT__ не нужен.
//
// Сигнатура обработчиков: function(eventArgs..., ctx)
//   ctx.form     — DataForm текущей формы
//   ctx.fnParams — параметры из лейаута (с резолвом {data.field})
//
// Файл должен заканчиваться return { ... } — этого требует loadScript().

// «Печать»: сохранить (если изменено) → серверная генерация HTML → printPreview.
// Паттерн printInvoice из счёта (apps/invoice), отчёт — reports.generatePriceListHTML.
async function printPriceList(ev, ctx) {
    var form = ctx.form;
    var uidEntry = form._dataMap && form._dataMap['UID'];
    var priceListId = uidEntry && uidEntry.value;
    if (!priceListId) { showAlert(__t('Please save the price list first')); return; }

    var needSave = false;
    if (form.needsSave()) {
        var ok = await showConfirm(__t('Save before printing?'));
        if (!ok) return;
        needSave = true;
    }

    var busyToken = (window.MySpace && window.MySpace.showBusy) ? window.MySpace.showBusy(__t('Preparing price list…')) : null;
    var result;
    try {
        if (needSave) {
            await form.doAction('save');
            if (form.needsSave()) return; // сохранение не удалось, ошибка уже показана
        }
        result = await callServer('reports.actions', 'generatePriceListHTML', { priceListId: priceListId });
    } finally {
        if (busyToken != null && window.MySpace && window.MySpace.hideBusy) window.MySpace.hideBusy(busyToken);
    }
    if (!result || result.error) { showAlert(__t('Error: ') + (result && result.error || '')); return; }

    if (window.MySpace && typeof window.MySpace.open === 'function') {
        await window.MySpace.open('printPreview', { html: result.html, autoPrint: true });
    }
}

return { printPriceList };
