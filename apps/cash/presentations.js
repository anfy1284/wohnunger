'use strict';

/**
 * Представления (поле `name`) денежных документов.
 *
 * ФАЙЛ ГРУЗЯТ ДВА ПРОЦЕССА — главный и форкнутый воркер планировщика: денежный
 * документ создаёт не только человек на форме, но и ПРОВЕДЕНИЕ брони (аванс новой
 * брони → поступление, `ctx.createOnce`), а `init.js` воркер не выполняет. Отсюда
 * чистая фабрика без побочных эффектов (drive_root/entityHooks — `presentations.js`).
 *
 * Номер + дата операции + сумма: по этой строке документ узнаётся в списке ссылок и
 * в кассовой книге.
 */

const path = require('path');
const FW = path.join(__dirname, '..', '..', 'node_modules', 'my-old-space');
const money = require(path.join(FW, 'drive_root', 'db', 'money'));
const emptyValues = require(path.join(FW, 'drive_root', 'db', 'emptyValues'));

function cashPresentation(data) {
    const parts = [];
    if (data.number) parts.push(String(data.number));
    // Пустая дата операции (0001-01-01) — дата документа, а не «01.01.1».
    const src = (data.operationDate && !emptyValues.isEmptyDate(data.operationDate)) ? data.operationDate : data.date;
    const d = (src && !emptyValues.isEmptyDate(src)) ? new Date(src) : null;
    if (d && !isNaN(d.getTime())) {
        const p = n => String(n).padStart(2, '0');
        parts.push(`${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`);
    }
    if (data.amount !== undefined && data.amount !== null) {
        parts.push(money.db(money.num(data.amount)));
    }
    return parts.join(' ');
}

module.exports = function () {
    return {
        cash_receipts: async (data) => cashPresentation(data),
        cash_payments: async (data) => cashPresentation(data),
        cash_transfers: async (data) => cashPresentation(data)
    };
};
