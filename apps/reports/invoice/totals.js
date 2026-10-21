'use strict';

/**
 * ИТОГИ СЧЁТА — один расчёт на всех, кто спрашивает «сколько счёт просит».
 *
 * Вопрос задают трое, и ответ обязан быть одним:
 *   - печатная форма (`template.js`) — она его печатает;
 *   - выставление счёта (`invoices.server.js#postIssue`) — предоплата не может
 *     быть больше этой суммы, иначе клиенту уходит документ с отрицательной
 *     суммой к оплате;
 *   - подготовка счёта из брони и «Заполнить» — там программа САМА подставляет
 *     предоплату и обязана подставить допустимую.
 * Второй счёт-калькулятор разошёлся бы с печатью, и разошёлся бы молча.
 *
 * `discountable === false` (durchlaufender Posten, курортный сбор) — оборот
 * общины: отель не вправе его уменьшать (§ 10 Abs. 1 Satz 4 UStG), поэтому
 * такие строки в базу скидки не входят. Признак — ДАННЫЕ справочника
 * (`tax_categories.discountable`), а не код. Нет снапшота категории у строки
 * (человек вручную сменил ставку) — строка считается скидочной.
 *
 * ДВА УРОВНЯ СКИДКИ (решение владельца 19.10.2026). Скидка брони живёт в строке
 * этой брони в ТЧ счёта «Buchungen» (`invoice_bookings.discountMode/Value`) и
 * действует ТОЛЬКО на строки своей брони: в общем счёте на брони с 10 % и 0 %
 * гость второй брони скидки не получает (прогон 17.10.2026, Q3b — получал).
 * Скидка в шапке счёта — дополнительная, на весь счёт, и считается от того, что
 * осталось после скидок броней. Старые счета хранят скидку только в шапке — для
 * них расчёт тот же, что был.
 *
 * Раскладка скидки ПО СТРОКАМ (`lineBrutto`) — тоже здесь: из неё печать строит
 * свод НДС по ставкам (§ 14 Abs. 4 Nr. 7 UStG). Пропорциональная раскладка по
 * всему счёту при разных скидках броней дала бы неверное нетто по ставкам.
 */

const path = require('path');
const M = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'my-old-space', 'drive_root', 'db', 'money'));

/**
 * Скидка от базы. Процент — доля базы. Сумма — со ЗНАКОМ базы: у сторно база
 * отрицательна, и фиксированная скидка 10 € там −10 €, а не 0 (раньше она
 * упиралась в границу [база, 0] и пропадала). Границы — по знаку базы.
 */
function discountOf(base, mode, value) {
    const v = M.num(value);
    if (!v || !base) return 0;
    let d = (mode === 'amount')
        ? (base < 0 ? -Math.abs(v) : Math.abs(v))
        : M.pct(base, v);
    const lo = Math.min(0, base), hi = Math.max(0, base);
    if (d < lo) d = lo;
    if (d > hi) d = hi;
    return d;
}

/**
 * Разложить скидку `discount` по строкам `lines` пропорционально их сумме;
 * копеечный дрейф — в самую крупную по модулю строку (у сторно суммы
 * отрицательны, и «крупнейшая по значению» была бы самой мелкой).
 */
function allocate(lines, base, discount, out) {
    if (!lines.length) return;
    const k = base !== 0 ? (base - discount) / base : 1;
    let sum = 0, drift = null;
    for (const ln of lines) {
        const v = M.mul(out.get(ln), k);
        out.set(ln, v);
        sum = M.add(sum, v);
        if (!drift || M.cmp(Math.abs(M.num(ln.amount)), Math.abs(M.num(drift.amount))) > 0) drift = ln;
    }
    const d = M.sub(M.sub(base, discount), sum);
    if (d !== 0 && drift) out.set(drift, M.add(out.get(drift), d));
}

/**
 * @param {Object} p
 * @param {Array}  p.lines — строки счёта (нужны `amount`, `taxCategoryId`, `bookingId`)
 * @param {Object} p.invoice — запись счёта (`discountMode`, `discountValue` — скидка на весь счёт)
 * @param {Array}  [p.bookingDiscounts] — строки ТЧ «Buchungen» (`bookingId`, `discountMode`, `discountValue`)
 * @param {Object} [p.taxCategories] — { [UID]: { discountable } }
 * @returns {{subtotalBrutto:number, discountBase:number, discount:number,
 *            discountedBrutto:number, isDiscountable:function,
 *            lineBrutto:Map, discountLines:Array<{mode,value,amount}>}}
 */
function invoiceTotals({ lines, invoice, taxCategories, bookingDiscounts }) {
    const catMap = taxCategories || {};
    const isDiscountable = (ln) => {
        const c = ln && ln.taxCategoryId ? catMap[ln.taxCategoryId] : null;
        return !(c && c.discountable === false);
    };

    const all = lines || [];
    const lineBrutto = new Map();
    let subtotalBrutto = 0, discountBase = 0;
    for (const ln of all) {
        subtotalBrutto = M.add(subtotalBrutto, ln.amount);
        lineBrutto.set(ln, M.num(ln.amount));
        if (isDiscountable(ln)) discountBase = M.add(discountBase, ln.amount);
    }

    // 1. Скидки броней — каждая на строки СВОЕЙ брони.
    const discountLines = [];
    let discount = 0;
    const byBooking = new Map();
    for (const b of (bookingDiscounts || [])) {
        if (!b || !b.bookingId || !M.num(b.discountValue)) continue;
        byBooking.set(b.bookingId, { mode: b.discountMode || 'percent', value: M.num(b.discountValue) });
    }
    for (const [bookingId, d] of byBooking) {
        const own = all.filter(ln => ln.bookingId === bookingId && isDiscountable(ln));
        const base = own.reduce((s, ln) => M.add(s, ln.amount), 0);
        const amt = discountOf(base, d.mode, d.value);
        if (!amt) continue;
        allocate(own, base, amt, lineBrutto);
        discount = M.add(discount, amt);
        // Одинаковые скидки разных броней печатаются одной строкой: бронь в строке
        // скидки не называется (решение владельца 19.10.2026) — её строки и так
        // стоят в своей секции счёта.
        const same = discountLines.find(x => !x.invoiceLevel && x.mode === d.mode && x.value === d.value);
        if (same) same.amount = M.add(same.amount, amt);
        else discountLines.push({ mode: d.mode, value: d.value, amount: amt, invoiceLevel: false });
    }

    // 2. Скидка шапки — на весь счёт, от того, что осталось после скидок броней.
    const disc = (invoice && M.num(invoice.discountValue)) || 0;
    if (disc) {
        const rest = all.filter(isDiscountable);
        const base = rest.reduce((s, ln) => M.add(s, lineBrutto.get(ln)), 0);
        const amt = discountOf(base, (invoice && invoice.discountMode) || 'percent', disc);
        if (amt) {
            allocate(rest, base, amt, lineBrutto);
            discount = M.add(discount, amt);
            discountLines.push({ mode: (invoice && invoice.discountMode) || 'percent', value: disc, amount: amt, invoiceLevel: true });
        }
    }

    return {
        subtotalBrutto,
        discountBase,
        discount,
        discountedBrutto: M.sub(subtotalBrutto, discount),
        isDiscountable,
        lineBrutto,
        discountLines
    };
}

module.exports = { invoiceTotals, discountOf };
