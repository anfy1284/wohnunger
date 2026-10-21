'use strict';

/**
 * СПОСОБ ОПЛАТЫ ↔ ВИД МЕСТА ХРАНЕНИЯ — одно правило, объявленное один раз.
 *
 * Зачем правило вообще. Кассовая книга (§ 146 Abs. 1 AO) ведёт НАЛИЧНЫЕ, и
 * безналичный оборот в неё не входит (разъяснения BMF по картам): перевод или
 * карта, попавшие в кассу, делают кассовую книгу неверной — остаток наличных
 * в ней больше, чем денег в ящике. Обратное так же неверно: наличные,
 * записанные на банковский счёт, из кассовой книги исчезают.
 *
 * Поэтому «куда можно положить» выводится из способа оплаты, а не выбирается
 * свободно. Правило живёт ЗДЕСЬ, в одном месте, потому что его спрашивают двое:
 * денежный документ при сохранении (`cash_documents.server.js#onBeforeSave` —
 * отказ словами) и всякий, кто создаёт документ за человека (диалог аванса на
 * форме брони) — ему нужно подставить ПРАВИЛЬНОЕ место, а не место «по
 * умолчанию». Два списка разошлись бы при первом же новом способе оплаты.
 *
 * Найдено живым прогоном 16.10.2026: диалог «Anzahlung» ставил способ
 * «Überweisung», а место — кассу организации по умолчанию, и перевод уехал
 * в кассовую книгу.
 */

const path = require('path');
const { Op } = require('sequelize');
const FW = path.join(__dirname, '..', '..', '..', 'node_modules', 'my-old-space');
const dbGateway = require(path.join(FW, 'drive_root', 'dbGateway'));

/**
 * Какие виды места хранения допустимы для способа оплаты.
 * Транзит — тоже безналичное место («деньги в пути» до зачисления на счёт).
 */
const KINDS_BY_METHOD = {
    cash:     ['cash'],
    transfer: ['bank', 'transit'],
    card:     ['bank', 'transit']
};

/** Способ оплаты по умолчанию, если в документе он не заполнен. */
const DEFAULT_METHOD = 'cash';

/** Допустимые виды места для способа оплаты (неизвестный способ не ограничиваем). */
function kindsForMethod(method) {
    const m = method || DEFAULT_METHOD;
    return KINDS_BY_METHOD[m] || null;
}

/**
 * Можно ли положить оплату этим способом в место этого вида.
 * Неизвестный способ или неизвестный вид — не запрещаем: правило отвечает
 * только за то, что знает, а молчаливый запрет на новом виде места хуже.
 */
function isAllowed(method, kind) {
    const kinds = kindsForMethod(method);
    if (!kinds || !kind) return true;
    return kinds.indexOf(kind) >= 0;
}

/**
 * Место хранения для оплаты этим способом: среди мест организации, у которых
 * подходящий вид, предпочитаем отмеченное «по умолчанию».
 *
 * Отбор по виду идёт ЗАПРОСОМ, а не выбором из первого попавшегося: «место по
 * умолчанию» у организации одно, и для безналичной оплаты оно обычно не
 * подходит.
 *
 * @returns {Promise<Object|null>} строка `cashboxes` или null, если такого места нет
 */
async function findPlaceForMethod({ organizationId, method, sessionID, appName, gateway }) {
    const kinds = kindsForMethod(method);
    const where = { organizationId: organizationId || null };
    if (kinds) where.kind = kinds.length === 1 ? kinds[0] : { [Op.in]: kinds };

    // `gateway` — шлюз ПРОВЕДЕНИЯ, когда место ищет обработчик проведения (аванс
    // новой брони): чтение идёт в его транзакции. Иначе — обычный шлюз под сессией.
    const rows = await (gateway || dbGateway).execute({
        operation: 'read', table: 'cashboxes', where,
        options: { raw: true },
        context: { appName: appName || 'cash', sessionID }
    });
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return null;
    return list.find(r => r && r.isDefault) || list[0];
}

module.exports = {
    KINDS_BY_METHOD, DEFAULT_METHOD,
    kindsForMethod, isAllowed, findPlaceForMethod
};
