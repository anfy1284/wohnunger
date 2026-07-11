'use strict';

// Серверные функции формы справочника «Сезон».
//
// Экспортирует фабрику: module.exports = function(modelsDB, Utilities) { return { ... }; }
// Вызывается из init.js: loadServerScript('seasons.actions', require('./forms/seasons.server')(modelsDB, Utilities), 'user')
//
// Каждая функция получает (params, ctx) где ctx = { sessionID, user, role }.

const { tForSession } = require('../../../node_modules/my-old-space/drive_forms/globalServerContext');

module.exports = function (modelsDB, Utilities) {

    return {

        // ── Серверное событие формы: вызывается ДО записи в БД ────────────
        // 1. Заполняет organizationId в записи и в строках ТЧ (паттерн priceList).
        // 2. Контроль периодов: обе даты заполнены, dateFrom < dateTo.
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
                    console.warn('[seasons/onBeforeSave] Could not resolve user org:', e && e.message);
                }
            }
            let orgId = changes.organizationId;
            if (!orgId) {
                const sId = parentUID || (changes && changes.UID);
                if (sId) {
                    try {
                        const dbRec = await modelsDB.Seasons.findByPk(sId, { raw: true });
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

            // 2. Контроль периодов
            for (const row of (tabularSections.season_periods || [])) {
                if (!row.dateFrom || !row.dateTo) {
                    throw new Error(await tForSession('season_period_dates_required', ctx.sessionID));
                }
                if (new Date(row.dateTo) <= new Date(row.dateFrom)) {
                    throw new Error(await tForSession('season_period_invalid', ctx.sessionID));
                }
            }
        }

    };
};
