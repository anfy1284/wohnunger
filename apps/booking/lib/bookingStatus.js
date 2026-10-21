'use strict';

/**
 * ДЕЛОВОЕ СОСТОЯНИЕ БРОНИ — один ответ на вопрос «отменена ли она».
 *
 * Состояние лежит ссылкой (`bookings.statusId` → справочник `booking_statuses`),
 * а узнаётся по `code`, а не по имени: имя переводимое, его правит владелец, и
 * сравнение с «Storniert» сломалось бы на первой же смене языка организации.
 *
 * Спрашивают это трое — проведение брони, правила её оповещений и создание
 * счёта, — поэтому ответ живёт здесь, а не копией в каждом. Модуль — чистая
 * фабрика без побочных эффектов: проведение и суточный проход идут в форкнутом
 * воркере, где `init.js` не выполнялся.
 *
 * ОТМЕНЁННАЯ БРОНЬ НИЧЕГО НЕ ЗАКАЗЫВАЛА (решение владельца 17.10.2026): гость не
 * приехал, услуги не оказаны. Поэтому её проведение не пишет движений
 * «заказано», оповещения «не выставлено» и «нет цены» не появляются, а счёт по
 * ней выставить нельзя. Плата за отмену (Stornogebühr) — отдельный предмет: это
 * не услуга проживания, и оформляется она своим документом.
 *
 * Если счёт был выставлен ДО отмены, остаток регистра уходит в минус — и это
 * верно: появляется «выставлено больше, чем заказано», то есть ровно случай
 * § 17 Abs. 1 UStG, который закрывается корректировкой счёта.
 */

const path = require('path');
const FW = path.join(__dirname, '..', '..', '..', 'node_modules', 'my-old-space');
const dbGateway = require(path.join(FW, 'drive_root', 'dbGateway'));

/** Код отменённого состояния в справочнике `booking_statuses`. */
const CANCELLED = 'cancelled';

/** Кэш «UID состояния → код» на процесс: справочник маленький и не меняется. */
const codeByUid = new Map();

/**
 * Код делового состояния по его UID.
 *
 * Читается через шлюз — теми же правами и в той же транзакции, что и
 * вызывающий: внутри проведения состояние могло только что измениться, и
 * чтение мимо транзакции вернуло бы прежнее.
 */
async function codeOf(statusId, ctx) {
    if (!statusId) return null;
    if (codeByUid.has(statusId)) return codeByUid.get(statusId);

    const opts = { raw: true, limit: 1 };
    if (ctx && ctx.transaction) opts.transaction = ctx.transaction;
    const context = { appName: 'booking', sessionID: ctx && ctx.sessionID };
    if (ctx && ctx.transaction) context.transaction = ctx.transaction;

    const rows = await dbGateway.execute({
        operation: 'read', table: 'booking_statuses',
        where: { UID: statusId }, options: opts, context
    });
    const code = (Array.isArray(rows) && rows[0] && rows[0].code) || null;
    if (code) codeByUid.set(statusId, code);
    return code;
}

/**
 * Отменена ли бронь.
 *
 * @param {Object} doc — строка брони (нужен `statusId`)
 * @param {Object} ctx — `{ sessionID, transaction? }`
 */
async function isCancelled(doc, ctx) {
    if (!doc) return false;
    return (await codeOf(doc.statusId, ctx || {})) === CANCELLED;
}

module.exports = { CANCELLED, codeOf, isCancelled };
