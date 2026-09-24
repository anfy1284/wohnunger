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
const money = require(path.join(FW, 'drive_root', 'db', 'money'));
const emptyValues = require(path.join(FW, 'drive_root', 'db', 'emptyValues'));

/**
 * Денежные реквизиты денежных документов — те, у которых минус бессмыслен.
 * Список один на все три вида документа: у прихода и расхода есть только
 * `amount`, у переноса рядом стоит `feeAmount`, и лишнее имя в списке ничего не
 * стоит, а забытое — стоит дорого (см. `onBeforeSave`).
 */
const MONEY_FIELDS = ['amount', 'feeAmount'];

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

        // Отрицательные значения запрещены у КАЖДОГО денежного реквизита, а не
        // только у главного. Направление задаёт ВИД ДОКУМЕНТА (приход или
        // расход), а не знак числа: «приход на минус сто» означал бы расход,
        // которого никто не стал бы искать в журнале расходов.
        //
        // Почему список, а не одна проверка `amount`. Ровно так и было — и
        // комиссия переноса осталась без присмотра. А она ВЫЧИТАЕТСЯ:
        // `получено = сумма − комиссия`, и комиссия −50 даёт 100 − (−50) = 150,
        // то есть движения −100 и +150 и полсотни евро из воздуха в остатке
        // кассы. Проверка в обработчике проведения это не ловила: она смотрит
        // `получено < 0`, а 150 больше нуля. Новый денежный реквизит документа
        // обязан попасть в этот список.
        for (const field of MONEY_FIELDS) {
            if (data[field] === undefined) continue;
            if (money.cmp(money.num(data[field] || 0), 0) < 0) {
                return { error: await t(ctx, 'cash_err_negative_amount', 'Сумма не может быть отрицательной') };
            }
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

    return { onBeforeSave };
};
