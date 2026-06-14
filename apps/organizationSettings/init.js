'use strict';

// Точка регистрации формы "Настройки организации".
// Автоматически вызывается фреймворком при старте (по записи в apps.json).
//
// organizationSettings — зеркало UserSettings, но значения хранятся по organizationId.
// Меню открывает напрямую uniForm с виртуальной таблицей organization_settings;
// кастомный лейаут строится динамически из organization_settings_fields в buildLayout().
//
// Структура:
//   forms/organization_settings.server.js — модуль-фабрика RPC + buildLayout()
//   forms/organization_settings.client.js — клиентский JS (__SERVER_SCRIPT__ плейсхолдер)
//   db/db.json                            — EAV-схема
//   db/defaultValues.json                 — типы значений + поле defaultTaxRate

const path = require('path');
const fs   = require('fs');

module.exports = async function (modelsDB) {
    try {
        const { loadScript, loadServerScript, Utilities } = require('../../node_modules/my-old-space');
        const layoutMemory = require('../../node_modules/my-old-space/drive_root/layoutMemory');

        const settingsServer = require('./forms/organization_settings.server');
        const serverFns = settingsServer(modelsDB, Utilities);
        const serverScriptName = loadServerScript('organizationSettings.actions', serverFns, 'user');

        const clientSource = fs
            .readFileSync(path.join(__dirname, 'forms/organization_settings.client.js'), 'utf8')
            .replace(/__SERVER_SCRIPT__/g, serverScriptName);
        const clientUID = await loadScript(clientSource, 'user');

        const layout = await settingsServer.buildLayout(modelsDB);

        await layoutMemory.saveLayout({
            appName:   'uniForm',
            mode:      'record',
            tableName: 'organization_settings',
            roles:     'user',
            layout,
            clientScript: clientUID,
            formIcon:  '/apps/general_icons/resources/public/16x16/settings.png',
            appCaption: { i18n: 'organization_settings_app_caption' },
            events: {
                onLoadData: { serverScript: serverScriptName, fn: 'onLoadData' },
                onSave:     { serverScript: serverScriptName, fn: 'onSave' }
            }
        });

        const mainMenu = require('../../node_modules/my-old-space/apps/main_menu/server.js');
        mainMenu.addMenuItems([{
            id: 'main',
            items: [{
                caption: { i18n: 'organization_settings_app_caption' },
                action: 'open',
                singleton: true,
                appName: 'uniForm',
                order: 101, // настройки — в конец списка меню, после пользовательских (см. sortByOrder)
                params: { mode: 'record', dbTable: 'organization_settings' }
            }]
        }]);

        console.log('[organizationSettings/init] Layout registered');
    } catch (e) {
        console.error('[organizationSettings/init] Failed:', e && e.message || e);
    }
};
