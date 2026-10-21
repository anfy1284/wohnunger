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
        // 3. Контроль строк проживания: сезон обязателен (справочник seasons).
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
            // Организация отеля — если у пользователя её не нашлось (прайс-лист
            // принадлежит отелю, другой организации у него быть не может).
            if (!changes.organizationId && !(record && record.organizationId) && (changes.hotelId || (record && record.hotelId))) {
                try {
                    const h = await modelsDB.Hotels.findByPk(changes.hotelId || record.hotelId, { raw: true });
                    if (h && h.organizationId) changes.organizationId = h.organizationId;
                } catch (_) {}
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

            // 2. Санитизация пустых значений здесь НЕ делается.
            //    Это работа фреймворка: пустое значение приводится к пустому
            //    значению своего типа (число → 0), NULL остаётся только у
            //    полей-ссылок. Единая реализация — drive_root/db/emptyValues,
            //    применяется в схеме, в шлюзе и при сохранении ТЧ.
            //    Прежняя прикладная заплатка приводила "" → null и расходилась
            //    с фреймворком; из-за разночтения «0 или NULL» строка
            //    прайс-листа раздваивалась на две позиции и цена переставала
            //    применяться. Пустые границы возраста означают «ограничения
            //    нет» и теперь хранятся как 0 — трактовку обеспечивает
            //    priceResolver (hasAgeBand / ageBandMatches).

            // 3. Сезон в строках проживания обязателен (в модели seasonId
            //    nullable ради мягкой миграции существующих таблиц — поэтому
            //    обязательность контролируется здесь).
            for (const row of (tabularSections.price_list_room_prices || [])) {
                if (!row.seasonId) {
                    throw new Error(await tForSession('price_list_season_required', ctx.sessionID));
                }
            }

            // 4. Сезон строки — сезон ОТЕЛЯ прайс-листа (решение владельца 16.10.2026:
            //    у каждого отеля свои сезоны). Подбор в строке уже отбирает сезоны по
            //    отелю (selection.where), но подбор — удобство, а правило держится здесь:
            //    строку могли заполнить до смены отеля в шапке.
            let plHotel = changes.hotelId || (record && record.hotelId) || null;
            if (!plHotel && (parentUID || changes.UID)) {
                try {
                    const dbRec = await modelsDB.PriceLists.findByPk(parentUID || changes.UID, { raw: true });
                    if (dbRec) plHotel = dbRec.hotelId;
                } catch (_) {}
            }
            // Цены по видам гостей — тот же сезон отеля (сезон там необязателен).
            const roomRows = (tabularSections.price_list_room_prices || [])
                .concat(tabularSections.price_list_guest_type_prices || []);
            if (plHotel && roomRows.length) {
                const ids = [...new Set(roomRows.map(r => r.seasonId).filter(Boolean))];
                const seasons = ids.length ? await modelsDB.Seasons.findAll({ where: { UID: ids }, raw: true }) : [];
                for (const sRec of seasons) {
                    if (sRec.hotelId && sRec.hotelId !== plHotel) {
                        const { tfForSession } = require('../../../node_modules/my-old-space/drive_forms/globalServerContext');
                        throw new Error(await tfForSession('price_list_season_other_hotel', ctx.sessionID, { season: sRec.name }));
                    }
                }
            }
        }

    };
};
