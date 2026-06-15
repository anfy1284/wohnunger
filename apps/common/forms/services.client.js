// Клиентские функции формы "Услуга".
//
// Открытие редактора формулы по кнопке «...» поля "Формула расчёта количества".
// Поле — обычный textbox с showSelectionButton (без справочника), поэтому штатный
// onSelectionStart ничего не открывает (см. гард в TextBox.onSelectionStart), а этот
// обработчик навешан через events: { onSelectionStart } и открывает приложение-редактор
// formula_editor. Редактор возвращает формулу через колбэк onApply.

async function openFormulaEditor(ctx) {
    var form = ctx.form;
    var ctrl = form.controlsMap && form.controlsMap['quantityFormula'];
    if (!ctrl) return;

    var current = '';
    try { current = (typeof ctrl.getValue === 'function' ? ctrl.getValue() : (typeof ctrl.getText === 'function' ? ctrl.getText() : '')) || ''; } catch (_) {}

    if (!window.MySpace || typeof window.MySpace.open !== 'function') {
        if (typeof showAlert === 'function') showAlert(__t('Formula editor is unavailable'));
        return;
    }

    try {
        await window.MySpace.open('formula_editor', {
            formula: current,
            onApply: function (newFormula) {
                var val = (newFormula == null) ? '' : String(newFormula);
                try {
                    if (typeof ctrl.setText === 'function') ctrl.setText(val);
                    else if (ctrl.element) ctrl.element.value = val;
                    if (ctrl.element) ctrl.element.dispatchEvent(new Event('input', { bubbles: true }));
                    if (typeof form.setModified === 'function') form.setModified(true);
                } catch (_) {}
            }
        });
    } catch (e) {
        if (typeof showAlert === 'function') showAlert(__t('Error: ') + (e && e.message || e));
    }
}

return { openFormulaEditor };
