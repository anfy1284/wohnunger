'use strict';

// Приложение «Редактор формул»: модальное окно для редактирования формулы
// расчёта количества услуги (services.quantityFormula). Открывается через
// MySpace.open('formula_editor', { formula, onApply }) с поля формулы.
//
// Серверный скрипт отдаёт список доступных переменных (token + перевод описания)
// из ЕДИНОГО реестра formulaEngine — без дублирования логики на клиенте.
module.exports = async function (modelsDB) {
    try {
        const { loadServerScript, Utilities } = require('../../node_modules/my-old-space');
        loadServerScript('formula_editor.actions', require('./forms/actions.server')(modelsDB, Utilities), 'user');
        console.log('[formula_editor/init] Server script registered');
    } catch (e) {
        console.error('[formula_editor/init] Failed:', e && e.message || e);
    }
};
