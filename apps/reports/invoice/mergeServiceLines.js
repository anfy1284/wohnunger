'use strict';

/**
 * СВЁРТКА СТРОК ОДНОЙ УСЛУГИ С РАЗНЫМИ ЦЕНАМИ — ТОЛЬКО ПЕЧАТЬ (решение владельца 21.10.2026).
 *
 * Одна услуга одной брони печаталась несколькими строками, когда её цена в разных
 * строках разная: завтрак взрослого и ребёнка («Frühstück — Erwachsener – Speisen» /
 * «… — Kind 6–13 Jahre – Speisen»), уборка двух квартир с разной ценой
 * («Endreinigung» 100 € и 40 €). Настройка гостиницы «Gleiche Leistungen mit
 * verschiedenen Preisen zusammenfassen» (`invoice.mergeServiceLines`) сворачивает их
 * В ПЕЧАТНОЙ ФОРМЕ в одну строку: «Frühstück – Speisen», количество — сумма, цена за
 * единицу — «–», сумма — сумма.
 *
 * Строки счёта в базе НЕ меняются: они остаются по типам гостей и номерам, из них
 * пишется «выставлено» в регистр услуг и считается коррекция. Итоги и свод НДС шаблон
 * считает из этих же исходных строк (template.js), сворачивается только таблица позиций.
 *
 * ПРАВО (сверено с текстом § 14 Abs. 4 Satz 1 UStG, gesetze-im-internet.de): цену за
 * единицу закон не требует — Nr. 5 «Menge und die Art … oder den Umfang und die Art
 * der sonstigen Leistung», Nr. 7 — вознаграждение, разбитое по ставкам, Nr. 8 — ставка
 * и налог. Поэтому строки РАЗНЫХ ставок (Speisen 7 % / Getränke 19 %) и категорий не
 * сворачиваются никогда: ставка и категория входят в ключ.
 *
 * ЧТО СВОРАЧИВАЕТСЯ: строки УСЛУГ (`serviceId`) одной брони, одной услуги, одного
 * налогового компонента, ставки и категории, если таких строк больше одной (одинаковые
 * цены свёрнуты уже при заполнении — значит, различаются они ценой). Строки
 * ПРОЖИВАНИЯ (у них нет `serviceId`: номер, доплата за ребёнка в номере) не трогаются:
 * у них разные единицы (ночи номера и гостеночи), разные квартиры, и их сумма ничего
 * не значила бы.
 *
 * @param {Array<object>} lines — строки счёта в порядке печати
 * @returns {Array<object>} новые строки для печати (исходные не мутируются)
 */
function mergeServiceLines(lines) {
    const M = require('../../../node_modules/my-old-space/drive_root/db/money');
    const keyOf = (ln) => [ln.bookingId, ln.serviceId, ln.taxComponentId || ln.taxComponentName || '',
        M.db(ln.taxRate), ln.taxCategoryId || ''].join('|');

    const groups = new Map();
    for (const ln of (lines || [])) {
        if (!ln || !ln.serviceId) continue;
        const k = keyOf(ln);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(ln);
    }
    const mergeable = new Set();
    for (const [k, rows] of groups) if (rows.length > 1) mergeable.add(k);
    if (!mergeable.size) return lines;

    const out = [];
    const emitted = new Set();
    for (const ln of lines) {
        const k = ln && ln.serviceId ? keyOf(ln) : null;
        if (!k || !mergeable.has(k)) { out.push(ln); continue; }
        if (emitted.has(k)) continue;           // группа печатается на месте ПЕРВОЙ своей строки
        emitted.add(k);
        const rows = groups.get(k);
        const base = ln.sectionLabel || ln.label || '';
        const comp = ln.taxComponentName ? (' – ' + ln.taxComponentName) : '';
        out.push(Object.assign({}, ln, {
            label: base + comp,
            quantity: Math.round(rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0) * 100) / 100,
            // Общей цены за единицу у разных цен нет — печатается «–» (template.js), а не
            // средняя: средней цены в прайсе не существует.
            unitPrice: null,
            amount: M.db(M.sum(rows, 'amount')),
            guestTypeId: null,
            __mergedFrom: rows.length
        }));
    }
    return out;
}

module.exports = { mergeServiceLines };
