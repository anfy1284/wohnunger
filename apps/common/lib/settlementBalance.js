'use strict';

/**
 * settlementBalance.js — остатки взаиморасчётов В РАЗРЕЗЕ БРОНИ.
 *
 * Общее место, потому что спрашивают из двух приложений: форма брони показывает
 * свою предоплату, счёт вычитает предоплату броней, из которых он собран. Один и
 * тот же вопрос, заданный дважды разным кодом, однажды получит два разных ответа —
 * особенно на знаке и на округлении.
 *
 * ПОЧЕМУ НЕ ПОЛЕ. Предоплата не хранится ни в брони, ни где-либо ещё: она ЕСТЬ
 * остаток регистра `reg_settlements` по (бронь, вид расчётов) — то есть сумма
 * проведённых денежных документов. Хранимое поле было бы вторым источником той же
 * величины, и разошлись бы они на первом же исправленном платеже.
 *
 * ЗНАК. В регистре `prepayment` > 0 означает «мы держим предоплату клиента» (наш
 * долг услугой). Наружу отдаём это же число: столько внесено.
 *
 * СУММЫ — строки (`DECIMAL` из драйвера). Складывать их только через `money.js`.
 */

const path = require('path');
const FW = path.join(__dirname, '..', '..', '..', 'node_modules', 'my-old-space');
const registers = require(path.join(FW, 'drive_root', 'db', 'registers'));
const money = require(path.join(FW, 'drive_root', 'db', 'money'));

/** Виды расчётов, которые умеет считать этот модуль. */
const KIND = { PREPAYMENT: 'prepayment', DEBT: 'debt', DEPOSIT: 'deposit' };

/**
 * ДЕНЕЖНЫЕ регистраторы расчётов — документы, которыми деньги ДВИЖУТСЯ
 * (поступление +, выплата/возврат −). Счёт тоже пишет в разрез предоплаты — он её
 * ЗАЧИТЫВАЕТ, — но денег не приносит и не уносит.
 *
 * Отсюда два разных вопроса к одному разрезу (ТЗ платежей брони, §3.4):
 *   «сколько внесено»   — движения только этих регистраторов (`paidOfBooking`);
 *   «сколько не зачтено» — весь остаток (`ofBooking`), его вычитает счёт.
 * Поле «Anzahlung» брони отвечает на первый: после выставления счёта там та же
 * сумма, а не 0, — «0» читался как «не платили».
 */
const MONEY_RECORDERS = ['cash_receipts', 'cash_payments'];

/**
 * Остаток по ОДНОЙ брони.
 *
 * @param {object} p
 * @param {string} p.bookingId
 * @param {string} [p.kind]      — вид расчётов, умолчание `prepayment`
 * @param {object} [p.moment]    — `{ date, seq }`; без него — на сейчас
 * @param {string} p.sessionID
 * @returns {Promise<string>} сумма строкой с двумя знаками («140.00»)
 */
async function ofBooking({ bookingId, kind, moment, sessionID }) {
    if (!bookingId) return money.db(0);
    const rows = await registers.balance({
        register: 'reg_settlements',
        dimensions: { bookingId, settlementKind: kind || KIND.PREPAYMENT },
        moment: moment || undefined,
        context: { appName: 'common', sessionID }
    });
    // Группировка идёт по всем измерениям, поэтому строк может быть несколько
    // (один клиент, разные организации). Складываем — вопрос был про бронь.
    let total = 0;
    for (const r of (rows || [])) total = money.add(total, r && r.amount);
    return money.db(total);
}

/**
 * Остатки по НЕСКОЛЬКИМ броням — одним запросом.
 *
 * Счёт собирается из нескольких броней, и спрашивать регистр по одной в цикле
 * значило бы сделать столько запросов, сколько броней. Тот же вопрос, заданный
 * оптом.
 *
 * @param {object} p — как `ofBooking`, но `bookingIds: string[]`
 * @returns {Promise<{ byBooking: Object<string,string>, total: string }>}
 */
async function ofBookings({ bookingIds, kind, moment, sessionID }) {
    const ids = [...new Set((bookingIds || []).filter(Boolean))];
    const byBooking = {};
    for (const id of ids) byBooking[id] = money.db(0);
    if (!ids.length) return { byBooking, total: money.db(0) };

    const rows = await registers.balance({
        register: 'reg_settlements',
        dimensions: { bookingId: ids, settlementKind: kind || KIND.PREPAYMENT },
        groupBy: ['bookingId'],
        moment: moment || undefined,
        context: { appName: 'common', sessionID }
    });

    let total = 0;
    for (const r of (rows || [])) {
        if (!r || !r.bookingId) continue;
        byBooking[r.bookingId] = money.db(r.amount);
        total = money.add(total, r.amount);
    }
    return { byBooking, total: money.db(total) };
}

/**
 * СКОЛЬКО ВСЕГО ВНЕСЕНО по брони: поступления минус возвраты, без зачёта счетами.
 * Тот же вопрос, что `ofBooking`, только к движениям денежных регистраторов.
 *
 * @param {object} p — как `ofBooking`
 * @returns {Promise<string>} сумма строкой с двумя знаками
 */
async function paidOfBooking({ bookingId, kind, moment, sessionID }) {
    if (!bookingId) return money.db(0);
    const rows = await registers.balance({
        register: 'reg_settlements',
        dimensions: { bookingId, settlementKind: kind || KIND.PREPAYMENT },
        recorderTables: MONEY_RECORDERS,
        moment: moment || undefined,
        context: { appName: 'common', sessionID }
    });
    let total = 0;
    for (const r of (rows || [])) total = money.add(total, r && r.amount);
    return money.db(total);
}

/**
 * Сколько внесено по НЕСКОЛЬКИМ броням — одним запросом (журнал броней).
 * @param {object} p — как `ofBookings`
 * @returns {Promise<{ byBooking: Object<string,string>, total: string }>}
 */
async function paidOfBookings({ bookingIds, kind, moment, sessionID }) {
    const ids = [...new Set((bookingIds || []).filter(Boolean))];
    const byBooking = {};
    for (const id of ids) byBooking[id] = money.db(0);
    if (!ids.length) return { byBooking, total: money.db(0) };

    const rows = await registers.balance({
        register: 'reg_settlements',
        dimensions: { bookingId: ids, settlementKind: kind || KIND.PREPAYMENT },
        groupBy: ['bookingId'],
        recorderTables: MONEY_RECORDERS,
        moment: moment || undefined,
        context: { appName: 'common', sessionID }
    });
    let total = 0;
    for (const r of (rows || [])) {
        if (!r || !r.bookingId) continue;
        byBooking[r.bookingId] = money.db(r.amount);
        total = money.add(total, r.amount);
    }
    return { byBooking, total: money.db(total) };
}

module.exports = { ofBooking, ofBookings, paidOfBooking, paidOfBookings, KIND, MONEY_RECORDERS };
