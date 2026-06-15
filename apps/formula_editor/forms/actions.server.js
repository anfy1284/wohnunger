'use strict';

// Серверные функции редактора формул.
// Источник переменных — общий модуль formulaEngine (реестр VARIABLES). Здесь
// только переводим описания на язык сессии (легенда редактора — это UI-подсказка,
// поэтому корректно использовать язык интерфейса пользователя).

const { tForSession } = require('../../../node_modules/my-old-space/drive_forms/globalServerContext');
const formulaEngine = require('../../common/lib/formulaEngine');

module.exports = function (modelsDB, Utilities) {
    return {
        // Возвращает доступные переменные, функции и подсказку по операторам
        // для легенды редактора. Описания переводятся на язык сессии (легенда —
        // UI-подсказка, поэтому корректно использовать язык интерфейса).
        //   variables:    [{ token: '@nights', description }]
        //   functions:    [{ token: 'if(cond, A, B)', insert: 'if(', description }]
        //   operatorsHelp: '<перевод подсказки по операторам>'
        async getFormulaVariables(params, ctx) {
            const tr = async (key) => { try { return await tForSession(key, ctx.sessionID); } catch (_) { return key; } };

            const out = [];
            for (const v of formulaEngine.listVariables()) {
                out.push({ token: v.token, description: await tr(v.descriptionKey) });
            }

            const fout = [];
            for (const f of formulaEngine.listFunctions()) {
                fout.push({ token: f.display, insert: f.insert, description: await tr(f.descriptionKey) });
            }

            return { variables: out, functions: fout, operatorsHelp: await tr('formula_operators_help') };
        }
    };
};
