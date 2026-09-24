'use strict';

/**
 * Серверные функции денежных документов.
 *
 * Фабрика, как у всех форм: `module.exports = (modelsDB, Utilities) => ({ ...fns })`.
 * Регистрируется в `init.js` через `loadServerScript`, имя скрипта в клиентский файл
 * подставляется заменой `__SERVER_SCRIPT__` — хардкодить его нельзя.
 */

const path = require('path');
const FW = path.join(__dirname, '..', '..', '..', 'node_modules', 'my-old-space');
const dbGateway = require(path.join(FW, 'drive_root', 'dbGateway'));
const money = require(path.join(FW, 'drive_root', 'db', 'money'));
const emptyValues = require(path.join(FW, 'drive_root', 'db', 'emptyValues'));
const registers = require(path.join(FW, 'drive_root', 'db', 'registers'));

module.exports = function (modelsDB, Utilities) {

    /**
     * Перед записью денежного документа.
     *
     * Единственное, что здесь делается сверх проверок, — ДАТА ОПЕРАЦИИ: если её
     * не заполнили, берём дату документа. Это не «удобство»: незаполненная дата
     * операции означала бы, что налоговая дата неизвестна, а пустая дата в этой
     * системе — `0001-01-01`, то есть вполне «заполненное» значение, которое
     * уехало бы в учёт молча (drive_root/db/emptyValues.js).
     */
    async function onBeforeSave(params, ctx) {
        const data = (params && params.data) || {};

        if (emptyValues.isEmptyDate(data.operationDate)) {
            data.operationDate = data.date || new Date();
        }

        // Сумма — через money.js: с формы приходит число, из базы строка, и
        // собственное округление разошлось бы с серверным на половине цента.
        if (data.amount !== undefined) data.amount = money.round(money.num(data.amount));
        if (data.feeAmount !== undefined) data.feeAmount = money.round(money.num(data.feeAmount));

        // Отрицательная сумма запрещена: направление задаёт ВИД ДОКУМЕНТА
        // (приход или расход), а не знак числа. Иначе «приход на минус сто»
        // означал бы расход, которого никто не искал бы в журнале расходов.
        if (money.cmp(money.num(data.amount || 0), 0) < 0) {
            return { error: await t(ctx, 'cash_err_negative_amount', 'Сумма не может быть отрицательной') };
        }
        return { ok: true, data };
    }

    async function t(ctx, key, fallback) {
        try {
            const { tForSession } = require(path.join(FW, 'drive_forms', 'globalServerContext'));
            const v = await tForSession(key, ctx && ctx.sessionID);
            if (v && v !== key) return v;
        } catch (e) { /* перевода нет */ }
        return fallback;
    }

    /**
     * ОСТАТОК по месту хранения на текущий момент — для подсказки на форме.
     * Считает регистр, а не свой SQL: второй способ посчитать остаток означал бы,
     * что однажды два экрана покажут разные числа.
     */
    async function cashboxBalance(params, ctx) {
        const { cashboxId, organizationId } = params || {};
        if (!cashboxId) return { ok: true, balance: '0.00' };
        const rows = await registers.balance({
            register: 'reg_cash',
            dimensions: { cashboxId, organizationId },
            context: { sessionID: ctx && ctx.sessionID }
        });
        const row = (rows && rows[0]) || null;
        return { ok: true, balance: row ? money.db(money.num(row.amount)) : '0.00' };
    }

    /**
     * ДВИЖЕНИЯ документа — «что этот документ сделал с учётом».
     * Нужны и пользователю (посмотреть, что получилось), и приёмке (убедиться,
     * что распроведение сняло всё).
     */
    async function documentMovements(params, ctx) {
        const { table, uid } = params || {};
        if (!table || !uid) return { ok: true, rows: [] };
        const rows = await registers.movementsOf({
            register: 'reg_cash', recorderTable: table, recorderUID: uid,
            context: { sessionID: ctx && ctx.sessionID }
        });
        return { ok: true, rows: rows || [] };
    }

    return { onBeforeSave, cashboxBalance, documentMovements };
};
