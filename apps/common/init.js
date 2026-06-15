'use strict';

// Общие справочники прикладного решения: организации, отели, номера,
// услуги, типы гостей, клиенты.
// Описание моделей — в db/db.json.
// Дефолтные значения (типы гостей) — в db/defaultValues.json.

const path = require('path');
const fs   = require('fs');

module.exports = async function (modelsDB) {
    try {
        const { loadScript } = require('../../node_modules/my-old-space');
        const layoutMemory   = require('../../node_modules/my-old-space/drive_root/layoutMemory');

        // ── Кастомная форма записи «Услуга» ──────────────────────────────
        // Нужна ради поля «Формула расчёта количества» (quantityFormula) с
        // кнопкой «...», открывающей редактор формул (приложение formula_editor).
        const servicesClient = fs.readFileSync(path.join(__dirname, 'forms/services.client.js'), 'utf8');
        const servicesClientUID = await loadScript(servicesClient, 'user');

        await layoutMemory.saveLayout({
            appName:       'uniForm',
            mode:          'record',
            tableName:     'services',
            roles:         'user',
            layout:        require('./forms/services.layout.json'),
            clientScript:  servicesClientUID,
            appCaption:    { i18n: 'services' },
            recordCaption: { i18n: 'service_record_caption' }
        });

        console.log('[common/init] Services layout registered');
    } catch (e) {
        console.error('[common/init] Failed:', e && e.message || e);
    }
};
