'use strict';

// Точка регистрации форм приложения "priceList" — документ «Прайс-лист».
// Автоматически вызывается фреймворком при старте (drive_forms/init.js).
//
// Прайс-лист устанавливает цены проживания и услуг, действующие с даты
// документа (системный реквизит date). Разрешение цен — «срез последних»
// по позиции: apps/common/lib/priceResolver.js.
//
// Структура приложения (паттерн разделённых файлов, эталон — apps/booking):
//   forms/price_lists.layout.json — JSON-лейаут формы записи
//   forms/price_lists.server.js   — серверные функции (onBeforeSave)
//   db/db.json                    — схема БД (документ + 2 ТЧ)
//   i18n.json                     — переводы

module.exports = async function (modelsDB) {
    try {
        const { loadServerScript, Utilities } = require('../../node_modules/my-old-space');
        const layoutMemory = require('../../node_modules/my-old-space/drive_root/layoutMemory');
        const entityHooks  = require('../../node_modules/my-old-space/drive_root/entityHooks');

        // ── Представление документа «Прайс-лист» (поле name) ─────────────
        // number + отель + дата документа (dd.MM.yyyy).
        entityHooks.registerPresentation('price_lists', async (data, ctx) => {
            const parts = [];
            if (data.number) parts.push(String(data.number));

            if (data.hotelId && ctx && ctx.modelsDB) {
                const Hotels = ctx.modelsDB.Hotels
                    || Object.values(ctx.modelsDB).find(m => m && m.tableName === 'hotels');
                if (Hotels) {
                    try {
                        const h = await Hotels.findByPk(data.hotelId, { raw: true });
                        if (h && h.name) parts.push(h.name);
                    } catch (e) { /* без имени отеля */ }
                }
            }

            if (data.date) {
                const dt = new Date(data.date);
                if (!isNaN(dt.getTime())) {
                    const p = n => String(n).padStart(2, '0');
                    parts.push(`${p(dt.getDate())}.${p(dt.getMonth() + 1)}.${dt.getFullYear()}`);
                }
            }

            return parts.join(' ');
        });

        // ── Форма «Прайс-лист» (таблица price_lists) ─────────────────────
        const serverScriptName = loadServerScript(
            'priceList.actions',
            require('./forms/price_lists.server')(modelsDB, Utilities),
            'user'
        );

        await layoutMemory.saveLayout({
            appName:      'uniForm',
            mode:         'record',
            tableName:    'price_lists',
            roles:        'user',
            layout:       require('./forms/price_lists.layout.json'),
            appCaption:   { i18n: 'price_list_app_caption' },
            recordCaption:{ i18n: 'PriceList' },
            formIcon:     '/apps/booking_icons/resources/public/16x16/price_list.png',
            listIcon:     '/apps/booking_icons/resources/public/16x16/price_list_journal.png',
            events: {
                onBeforeSave: { serverScript: serverScriptName, fn: 'onBeforeSave' }
            }
        });
        // Список — автогенерация uniForm (заголовок/иконка из appCaption/listIcon).

        // ── Сортировка журнала: по номеру от большего к меньшему ─────────
        layoutMemory.registerListSort('price_lists', [{ field: 'number', order: 'desc' }]);

        // ── Пункт в подменю главной кнопки ────────────────────────────────
        // Рядом с «Настройки пользователя» / «Настройки организации» (id:'main').
        // order:99 — прямо над настройками (у них order 100/101).
        const mainMenu = require('../../node_modules/my-old-space/apps/main_menu/server.js');
        mainMenu.addMenuItems([{
            id: 'main',
            items: [{
                caption: { i18n: 'price_list_app_caption' },
                action: 'open',
                singleton: true,
                appName: 'uniForm',
                order: 99,
                icon: '/apps/booking_icons/resources/public/16x16/price_list_journal.png',
                params: { mode: 'list', dbTable: 'price_lists' }
            }]
        }]);

        console.log('[priceList/init] Layouts registered');
    } catch (e) {
        console.error('[priceList/init] Failed:', e && e.message || e);
    }
};
