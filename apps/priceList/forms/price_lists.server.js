'use strict';

// Серверные функции формы «Прайс-лист».
//
// Экспортирует фабрику: module.exports = function(modelsDB, Utilities) { return { ... }; }
// Вызывается из init.js: loadServerScript('priceList.actions', require('./price_lists.server')(modelsDB, Utilities), 'user')
//
// Каждая функция получает (params, ctx) где ctx = { sessionID, user, role }.

const { tForSession } = require('../../../node_modules/my-old-space/drive_forms/globalServerContext');

module.exports = function (modelsDB, Utilities) {

    return {

        // ── Серверное событие формы: вызывается ДО записи в БД ────────────
        // 1. Заполняет organizationId в записи и во всех строках ТЧ (паттерн booking).
        // 2. Санитизация числовых полей строк ТЧ ("" → null, PostgreSQL не примет "").
        // 3. Контроль сезона в строках проживания: dateFrom < dateTo.
        async onBeforeSave({ record, changes, tabularSections, parentUID }, ctx) {
            // 1. organizationId
            if (!changes.organizationId) {
                try {
                    const globalCtx = require('../../../node_modules/my-old-space/drive_root/globalServerContext');
                    const user = await globalCtx.getUserBySessionID(ctx.sessionID);
                    if (user && user.organizationId) {
                        changes.organizationId = user.organizationId;
                    }
                } catch (e) {
                    console.warn('[priceList/onBeforeSave] Could not resolve user org:', e && e.message);
                }
            }
            let orgId = changes.organizationId;
            if (!orgId) {
                const plId = parentUID || (changes && changes.UID);
                if (plId) {
                    try {
                        const dbRec = await modelsDB.PriceLists.findByPk(plId, { raw: true });
                        if (dbRec) orgId = dbRec.organizationId;
                    } catch (_) {}
                }
            }
            if (orgId) {
                for (const rows of Object.values(tabularSections)) {
                    for (const row of rows) {
                        if (!row.organizationId) row.organizationId = orgId;
                    }
                }
            }

            // 2. Санитизация числовых полей ТЧ ("" → null)
            const numFields = ['guestsCount', 'price', 'ageFrom', 'ageTo'];
            for (const rows of Object.values(tabularSections)) {
                for (const row of rows) {
                    for (const f of numFields) {
                        if (row[f] === '') row[f] = null;
                    }
                }
            }

            // 3. Сезонный интервал строк проживания: dateFrom < dateTo
            for (const row of (tabularSections.price_list_room_prices || [])) {
                if (row.dateFrom && row.dateTo && new Date(row.dateTo) <= new Date(row.dateFrom)) {
                    throw new Error(await tForSession('price_list_season_invalid', ctx.sessionID));
                }
            }
        }

    };
};
