'use strict';

// Серверный модуль формы "Настройки организации".
//
// Зеркало UserSettings, но значения хранятся по organizationId (а не userId).
// Вверху формы — селектор организации (из доступных пользователю); при смене
// значения формы перезагружаются под выбранную организацию, при сохранении
// настройки пишутся именно в неё. Доступ ограничен организациями пользователя
// (источник — таблица связей user_organizations, как в RLS dbGateway).
//
// EAV-модель: organization_settings_fields — список настроек,
// значения — в таблицах по типу (organization_settings_string_values и т.д.).
//
// Экспортирует:
//   module.exports(modelsDB, Utilities) → { onLoadData, loadForOrg, onSave }
//   module.exports.buildLayout(modelsDB) → layout[]   — вызывается из init.js при старте

const globalRootCtx = require('../../../node_modules/my-old-space/drive_root/globalServerContext');
const { tForSession } = require('../../../node_modules/my-old-space/drive_forms/globalServerContext');

// Виртуальное имя поля-селектора организации (не настройка, а выбор scope).
const ORG_FIELD = '__orgId';

// PascalCase имя модели из имени таблицы: organization_settings_string_values → OrganizationSettingsStringValues
function modelNameFromTable(tableName) {
    return tableName.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

// Список организаций, доступных пользователю (источник истины — user_organizations,
// поле users.organizationId может быть пустым). Возвращает массив UID.
async function userOrgIds(sessionID, modelsDB) {
    const user = await globalRootCtx.getUserBySessionID(sessionID);
    if (!user) return [];
    const ids = [];
    try {
        if (modelsDB && modelsDB.UserOrganizations) {
            const links = await modelsDB.UserOrganizations.findAll({ where: { userId: user.UID }, raw: true });
            for (const l of links) if (l.organizationId && ids.indexOf(l.organizationId) < 0) ids.push(l.organizationId);
        }
    } catch (e) {
        console.warn('[OrganizationSettings] userOrgIds:', e && e.message);
    }
    if (user.organizationId && ids.indexOf(user.organizationId) < 0) ids.unshift(user.organizationId);
    return ids;
}

// Выбирает целевую организацию: предпочтительную (если доступна) иначе первую доступную.
async function resolveOrgId(sessionID, modelsDB, preferredOrgId) {
    const ids = await userOrgIds(sessionID, modelsDB);
    if (preferredOrgId && ids.indexOf(preferredOrgId) >= 0) return preferredOrgId;
    return ids.length ? ids[0] : null;
}

// ── Чтение настроек организации из EAV-таблиц ────────────────────────────────────────────
// Возвращает массив { name, value, display } (display — для ссылочных полей).
async function getSettings(orgId, modelsDB) {
    if (!modelsDB || !modelsDB.OrganizationSettingsFields) return [];

    const settingsFields = await modelsDB.OrganizationSettingsFields.findAll({
        include: [{ model: modelsDB.OrganizationSettingsTypes, as: 'type', attributes: ['UID', 'name', 'valueTableName'] }],
        order: [['displayOrder', 'ASC'], ['UID', 'ASC']]
    });

    const fields = [];
    for (const field of settingsFields) {
        const valueTableName = field.type ? field.type.valueTableName : null;
        const typeName = field.type ? field.type.name : '';
        let value = null;

        if (valueTableName && orgId) {
            const modelName = modelNameFromTable(valueTableName);
            if (modelsDB[modelName]) {
                const record = await modelsDB[modelName].findOne({ where: { organizationId: orgId, settingsFieldId: field.UID } });
                value = record ? record.value : (typeName === 'boolean' ? false : null);
            } else {
                console.warn('[OrganizationSettings] Model not found:', modelName);
            }
        }

        const out = { name: field.name, value: value, display: undefined };

        // Резолв отображаемого значения для ссылочных полей (referenceTable)
        const opts = field.options;
        if (opts && typeof opts === 'object' && !Array.isArray(opts) && opts.referenceTable && value) {
            const refModelName = modelNameFromTable(opts.referenceTable);
            if (modelsDB[refModelName]) {
                try {
                    const refRecord = await modelsDB[refModelName].findByPk(value);
                    if (refRecord) out.display = refRecord[opts.displayField || 'name'];
                } catch (e) {
                    console.warn('[OrganizationSettings] resolve reference:', field.name, e.message);
                }
            }
        }
        fields.push(out);
    }
    return fields;
}

// ── Запись настроек организации в EAV-таблицы ────────────────────────────────────────────
async function saveSettings(params, orgId, sessionID, modelsDB) {
    if (!modelsDB || !modelsDB.OrganizationSettingsFields) {
        return { error: await tForSession('Database models not available', sessionID) };
    }
    if (!orgId) return { error: await tForSession('User not authorized', sessionID) };

    const settingsFields = await modelsDB.OrganizationSettingsFields.findAll({
        include: [{ model: modelsDB.OrganizationSettingsTypes, as: 'type', attributes: ['UID', 'name', 'valueTableName'] }]
    });
    const fieldMap = {};
    settingsFields.forEach(f => { fieldMap[f.name] = f; });

    for (const [fieldName, value] of Object.entries(params)) {
        const field = fieldMap[fieldName];
        if (!field) continue; // не настройка (напр. __orgId) или неизвестное поле

        const valueTableName = field.type ? field.type.valueTableName : null;
        if (!valueTableName) continue;

        const modelName = modelNameFromTable(valueTableName);
        if (!modelsDB[modelName]) { console.warn('[OrganizationSettings] Model not found:', modelName); continue; }

        const typeName = field.type ? field.type.name : 'string';
        let preparedValue = value;
        if (typeName === 'number') {
            if (value === null || value === undefined || value === '') { preparedValue = null; }
            else {
                const num = (typeof value === 'number') ? value : Number(value);
                preparedValue = Number.isFinite(num) ? num : null;
            }
        } else if (typeName === 'boolean') {
            preparedValue = value === true || value === 'true';
        } else if (typeName === 'date') {
            if (!value || value === '' || value === 'Invalid date') { preparedValue = null; }
            else {
                const date = new Date(value);
                preparedValue = isNaN(date.getTime()) ? null : date;
            }
        } else {
            preparedValue = (value === null || value === undefined || value === '') ? null : String(value);
        }

        await modelsDB[modelName].upsert({ organizationId: orgId, settingsFieldId: field.UID, value: preparedValue });
    }

    return { success: true };
}

// ── Динамическая генерация лейаута из organization_settings_fields ────────────────────────
async function buildLayout(modelsDB) {
    const settingsFields = await modelsDB.OrganizationSettingsFields.findAll({
        include: [{ model: modelsDB.OrganizationSettingsTypes, as: 'type', attributes: ['UID', 'name', 'valueTableName'] }],
        order: [['displayOrder', 'ASC'], ['UID', 'ASC']]
    });

    const controls = [];
    for (const field of settingsFields) {
        const typeName = field.type ? field.type.name : '';
        const ctrl = {
            name:    field.name,
            data:    field.name,
            caption: { i18n: field.displayName || field.name }
        };

        const opts = field.options;
        if (opts && typeof opts === 'object' && !Array.isArray(opts) && opts.referenceTable) {
            ctrl.type = 'recordSelector';
            // No explicit button flag → client auto-picks dropdown (small list) vs "..." (large).
            ctrl.properties = {
                selection: {
                    table:        opts.referenceTable,
                    idField:      'UID',
                    displayField: opts.displayField || 'name'
                }
            };
        } else if (typeName === 'boolean') {
            ctrl.type = 'checkbox';
        } else if (typeName === 'date') {
            ctrl.type = 'date';
        } else if (typeName === 'enum' && field.options) {
            ctrl.type = 'emunList';
            const enumOpts = Array.isArray(field.options) ? field.options
                : (typeof field.options === 'string' ? JSON.parse(field.options) : []);
            // Элемент массива — либо строка-значение (caption = само значение),
            // либо объект { value, caption } — caption может быть { i18n: 'key' },
            // его переведут обходчики лейаута (translateLayoutCaptions обходит options).
            ctrl.options = enumOpts.map(o => (o && typeof o === 'object')
                ? { value: o.value, caption: o.caption || o.value }
                : { value: o, caption: o });
        } else if (typeName === 'number') {
            ctrl.type = 'number';
        } else if (opts && typeof opts === 'object' && !Array.isArray(opts) && opts.multiline) {
            // Свободный многострочный текст (напр. примечание к счёту) → textarea.
            ctrl.type = 'textarea';
            if (typeof opts.rows === 'number') ctrl.rows = opts.rows;
            if (typeof opts.cols === 'number') ctrl.cols = opts.cols;
        } else {
            ctrl.type = 'textbox';
        }

        controls.push(ctrl);
    }

    return [
        {
            type: 'commandBar',
            extraButtons: [
                {
                    name:    'btnApply',
                    caption: { i18n: 'Apply' },
                    icon:    '/apps/general_icons/resources/public/16x16/save.png',
                    events:  { onClick: 'applySettings' }
                }
            ]
        },
        {
            type:        'group',
            caption:     { i18n: 'Organization' },
            orientation: 'vertical',
            alignFields: true,
            layout: [
                {
                    type: 'recordSelector',
                    name: ORG_FIELD,
                    data: ORG_FIELD,
                    caption: { i18n: 'Organization' },
                    // No button flag → dropdown for the (usually few) organizations the
                    // user may access; the dropdown selection fires onChange (onOrgChanged).
                    properties: {
                        selection: { table: 'organizations', idField: 'UID', displayField: 'name' }
                    },
                    events: { onChange: 'onOrgChanged' }
                }
            ]
        },
        {
            type:        'group',
            caption:     { i18n: 'organization_settings_app_caption' },
            orientation: 'vertical',
            alignFields: true,
            layout:      controls
        }
    ];
}

// ── Модуль-фабрика: RPC-функции для loadServerScript ─────────────────────────────────────
module.exports = function factory(modelsDB, Utilities) {

    async function onLoadData({ tableName, params }, ctx) {
        const orgId = await resolveOrgId(ctx.sessionID, modelsDB, params && params.organizationId);

        const data = [];
        // Селектор организации (выбранная по умолчанию — первая доступная)
        let orgDisplay = '';
        if (orgId && modelsDB.Organizations) {
            try {
                const org = await modelsDB.Organizations.findByPk(orgId);
                if (org) orgDisplay = org.name;
            } catch (_) {}
        }
        data.push({ name: ORG_FIELD, value: orgId, selection: orgId ? { id: orgId, display: orgDisplay } : undefined, tabularSection: false });

        const fields = await getSettings(orgId, modelsDB);
        for (const f of fields) {
            const item = { name: f.name, value: f.value, tabularSection: false };
            if (f.display !== undefined && f.value) item.selection = { id: f.value, display: f.display };
            data.push(item);
        }

        return {
            data,
            caption: await tForSession('organization_settings_app_caption', ctx.sessionID)
        };
    }

    // Перезагрузка значений настроек под выбранную организацию (клиент: onOrgChanged).
    async function loadForOrg({ organizationId }, ctx) {
        const allowed = await userOrgIds(ctx.sessionID, modelsDB);
        if (!organizationId || allowed.indexOf(organizationId) < 0) {
            return { error: await tForSession('User not authorized', ctx.sessionID) };
        }
        const fields = await getSettings(organizationId, modelsDB);
        return { fields };
    }

    async function onSave({ changes }, ctx) {
        const plainChanges = Object.assign({}, changes || {});
        delete plainChanges.__tabularSections;

        // Целевая организация — из селектора формы; проверяем доступ пользователя к ней.
        const targetOrg = plainChanges[ORG_FIELD];
        delete plainChanges[ORG_FIELD];
        const allowed = await userOrgIds(ctx.sessionID, modelsDB);
        const orgId = (targetOrg && allowed.indexOf(targetOrg) >= 0) ? targetOrg : (allowed.length ? allowed[0] : null);
        if (!orgId) return { ok: false, error: await tForSession('User not authorized', ctx.sessionID) };

        const result = await saveSettings(plainChanges, orgId, ctx.sessionID, modelsDB);
        if (result.error) return { ok: false, error: result.error };
        return { ok: true };
    }

    return { onLoadData, loadForOrg, onSave };
};

module.exports.buildLayout = buildLayout;
