// Клиентские функции формы "Настройки организации".
//
// Загружается как исходный текст через loadScript() в init.js.
// Плейсхолдер __SERVER_SCRIPT__ заменяется на реальное имя серверного скрипта при загрузке.

// Сохранение настроек выбранной организации.
async function applySettings(ev, ctx) {
    var form = ctx.form;
    var data = form.collectData(); // включает __orgId — целевую организацию
    var result = await callServer('__SERVER_SCRIPT__', 'onSave', { changes: data, tableName: 'organization_settings' });
    if (result && result.error) {
        showAlert(__t('Error: ') + result.error);
        return;
    }
    form.setModified(false);
    showAlert(__t('Settings saved'));
}

// Смена организации в селекторе вверху формы — перезагружаем значения настроек
// под выбранную организацию (val — её UID).
async function onOrgChanged(val, display, ctx) {
    var form = ctx.form;
    if (!val) return;

    var result = await callServer('__SERVER_SCRIPT__', 'loadForOrg', { organizationId: val });
    if (!result || result.error) {
        if (result && result.error) showAlert(__t('Error: ') + result.error);
        return;
    }

    var fields = result.fields || [];
    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        var ctrl = form.controlsMap && form.controlsMap[f.name];
        if (ctrl && typeof ctrl.setValue === 'function') {
            ctrl.setValue(f.value, f.display);
        }
    }

    // Переключение организации не считаем несохранёнными изменениями.
    try { if (typeof form.setModified === 'function') form.setModified(false); } catch (_) {}
}

return { applySettings, onOrgChanged };
