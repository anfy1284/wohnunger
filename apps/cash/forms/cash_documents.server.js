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
const dbGateway = require(path.join(FW, 'drive_root', 'dbGateway'));
// Способ оплаты и вид места хранения обязаны совпадать — см. `_checkPaymentPlace`.
const cashPlaces = require('../lib/cashPlaces');

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
        // Метод формы получает `{ record, changes, … }` (16.10.2026). Раньше здесь
        // читалось `params.data` — его нет, и хук молча не делал ничего: пустая
        // дата операции уходила в учёт, кассовая книга печатала «01.01.1»
        // (прогон сценариев, F3).
        const data = (params && (params.changes || params.data)) || {};
        const record = (params && params.record) || {};
        const opDate = Object.prototype.hasOwnProperty.call(data, 'operationDate') ? data.operationDate : record.operationDate;
        if (emptyValues.isEmptyDate(opDate)) {
            const docDate = data.date || record.date;
            data.operationDate = emptyValues.isEmptyDate(docDate) ? new Date() : docDate;
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
                // Исключение, а не `{ error }`: отменяет сохранение только оно.
                throw new Error(await t(ctx, 'cash_err_negative_amount', 'Сумма не может быть отрицательной'));
            }
        }

        await _checkPaymentPlace(data, record, ctx);
        return { ok: true, data };
    }

    /**
     * СПОСОБ ОПЛАТЫ И МЕСТО ХРАНЕНИЯ ОБЯЗАНЫ СОВПАДАТЬ ПО ВИДУ.
     *
     * Кассовая книга ведёт наличные (§ 146 Abs. 1 AO), безналичный оборот в неё
     * не входит. Перевод, записанный в кассу, делает кассовую книгу неверной —
     * и делает это МОЛЧА: в книге просто появляется день с лишними деньгами.
     * Поэтому отказываем словами, назвав и место, и что выбрать вместо него.
     *
     * Правило — в `apps/cash/lib/cashPlaces.js`, одно на всех: его же
     * спрашивает тот, кто создаёт документ за человека (диалог аванса).
     *
     * У переноса между местами хранения ни способа оплаты, ни одного
     * `cashboxId` нет — проверять нечего, и выдумывать способ по виду места
     * тоже нельзя.
     */
    async function _checkPaymentPlace(data, record, ctx) {
        const has = (k) => Object.prototype.hasOwnProperty.call(data, k);
        const cashboxId = has('cashboxId') ? data.cashboxId : record.cashboxId;
        if (!cashboxId) return;
        const method = (has('paymentMethod') ? data.paymentMethod : record.paymentMethod)
            || cashPlaces.DEFAULT_METHOD;

        const rows = await dbGateway.execute({
            operation: 'read', table: 'cashboxes', where: { UID: cashboxId },
            options: { raw: true, limit: 1 },
            context: { appName: 'cash', sessionID: ctx && ctx.sessionID }
        });
        const box = (Array.isArray(rows) && rows[0]) || null;
        if (!box || cashPlaces.isAllowed(method, box.kind)) return;

        const place = box.name || box.number || '';
        const key = (method === 'cash') ? 'cash_err_cash_place_required' : 'cash_err_noncash_place_required';
        throw new Error(await tf(ctx, key, { place }));
    }

    /** Перевод с подстановками — ДВЕ фигурные скобки у ключей (`i18n.tf`). */
    async function tf(ctx, key, vars) {
        try {
            const { tfForSession } = require(path.join(FW, 'drive_forms', 'globalServerContext'));
            const v = await tfForSession(key, ctx && ctx.sessionID, vars || {});
            if (v && v !== key) return v;
        } catch (e) { /* перевода нет */ }
        return key;
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
