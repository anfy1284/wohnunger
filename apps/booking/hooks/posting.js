'use strict';

/**
 * Проведение брони: «что заказано» в регистр услуг по брони.
 *
 * ТЗ «Учёт услуг по брони», §6. Режим — `onSave`: бронь уходит в очередь при
 * каждом сохранении, команд и слова «провести» на форме нет (владелица о
 * проведении не узнаёт), а регистр наполняется сам.
 *
 * РАСЧЁТА ЗДЕСЬ НЕТ, и это главное. Состав услуг считает общий модуль
 * `apps/common/lib/bookingServices.js` — тот же, которым заполняется счёт. Если
 * бы бронь посчитала то же самое по-своему, два расчёта разошлись бы (вопрос
 * только когда), и остаток регистра начал бы врать, не сойдясь никогда и ни с
 * чем. Отсюда же — позиции берутся ЧЕРЕЗ СВЁРТКУ: ключ позиции у «заказано» и у
 * «выставлено» совпадает по построению, а не по договорённости.
 *
 * Распроведения здесь нет и быть не может: движения принадлежат
 * документу-регистратору, и снимает их ядро само
 * (`drive_root/db/posting.js#clearMovements`).
 */

const path = require('path');
const FW = path.join(__dirname, '..', '..', '..', 'node_modules', 'my-old-space');

const M = require(path.join(FW, 'drive_root', 'db', 'money'));
const { isEmptyDate } = require(path.join(FW, 'drive_root', 'db', 'emptyValues'));
const bookingServices = require('../../common/lib/bookingServices');
// «Отменена ли бронь» — один ответ на всю систему (см. lib/bookingStatus.js).
const bookingStatus = require('../lib/bookingStatus');
// Чем заполнить денежный документ по брони — одно правило с вкладкой «Zahlungen».
const paymentDocument = require('../lib/paymentDocument');
const { PostingError } = require(path.join(FW, 'drive_root', 'db', 'posting'));

/** Отказ провести бронь — причина видна человеку, поэтому с ключом перевода. */
function refuse(message, key, vars) {
    return new PostingError('[booking] ' + message, 'BOOKING_POSTING', key, vars || {});
}

module.exports = function (modelsDB, Utilities) {

    const api = bookingServices(modelsDB, Utilities);

    /**
     * ЗНАК. У этого регистра он постоянный: бронь всегда пишет `+1`, счёт всегда
     * `−1`, а величины едут такими, какими посчитаны. Это НЕ то же, что у
     * денежных документов, где знак берётся от суммы, и разница намеренная:
     * здесь ресурсов два (количество и сумма), и у строки они бывают разного
     * знака — бесплатная услуга даёт количество при нулевой сумме, а сторно-счёт
     * отрицает оба сразу. Знак «от суммы» в таком случае перевернул бы
     * количество не туда, причём молча. При постоянном знаке сторно-счёт
     * (у которого строки уже отрицательные) сам возвращает услуги в «не
     * выставлено» — отдельного кода для этого не нужно.
     */
    const SIGN_ORDERED = +1;

    /**
     * Обработчик проведения брони.
     *
     * Дата ценообразования — ДАТА ДОКУМЕНТА БРОНИ. Режим `pricingDateMode`
     * (бронь/счёт) здесь не спрашивается, и это не упущение: на момент
     * проведения брони счёта может не быть вовсе. Пережить разницу режимов
     * позволяет то, что цена НЕ входит в ключ позиции (ТЗ §5, решение владельца
     * 01.10.2026) — состав и количества от даты цен не зависят, поэтому
     * «заказано» и «выставлено» сходятся в любом режиме.
     */
    async function postServices(doc, ctx) {
        // Ключ позиции объявлен в одном месте, а измерения регистра — в другом
        // файле. Расхождение этих двух объявлений ядро не заметит: лишнее поле в
        // строке движения просто не доедет до таблицы, и остаток начнёт складывать
        // несравнимые позиции. Поэтому сверка — здесь, до первой записи.
        bookingServices.assertRegisterKey();

        // ОТМЕНЁННАЯ БРОНЬ НИЧЕГО НЕ ЗАКАЗЫВАЛА (решение владельца 17.10.2026):
        // гость не приехал, услуги не оказаны. Движений «заказано» нет — и всё
        // остальное выводится из этого само: остаток пуст, значит оповещение
        // «не выставлено» не появляется, а если счёт был выставлен ДО отмены,
        // остаток уходит в минус и правило «выставлено больше, чем заказано»
        // просит корректировку (§ 17 Abs. 1 UStG). Прежде отменённая бронь
        // продолжала требовать счёт каждое утро (прогон 16.10.2026, Q7a).
        //
        // Распроведения для этого НЕ НУЖНО: прежние движения ядро снимает перед
        // каждым вызовом обработчика, а обработчик просто не пишет новых.
        if (await bookingStatus.isCancelled(doc, ctx)) return;

        // БРОНЬ БЕЗ НОМЕРА — не бронь, а заготовка: заказывать нечего, и аванс по
        // ней в учёт не уходит (ТЗ платежей брони, приёмка п. 1). Отказ, а не
        // молчаливое «проведено, 0 движений»: человек ещё вводит бронь, и форма
        // покажет причину, а поля аванса останутся, пока бронь не проведётся.
        const rooms = await ctx.dbGateway.execute({
            operation: 'count', table: 'booking_rooms', where: { bookingId: doc.UID }
        });
        if (!Number(rooms)) {
            throw refuse('Бронь без номера — проводить нечего', 'booking_err_no_rooms');
        }

        // ПЕРВЫЙ АВАНС → документ поступления, ОДИН раз (ТЗ §3.3, §4.1). До
        // расчёта услуг не откладывается: ошибка дальше откатит транзакцию, а с
        // ней и созданный документ, — «не провелась — документа нет».
        await createFirstPrepaymentReceipt(doc, ctx);

        const pricingDate = isEmptyDate(doc.date) ? new Date() : new Date(doc.date);
        const { positions } = await api.orderedPositions({
            bookingId: doc.UID, pricingDate
        }, ctx);

        if (!positions.length) return;

        const rows = [];
        for (const p of positions) {
            const position = bookingServices.positionOf(p);
            const quantity = M.num(p.quantity);
            const amount   = M.num(p.amount);
            // Позиция без количества и без суммы движения не образует: пустая
            // строка в регистре только мешала бы читать остаток.
            if (M.isZero(quantity) && M.isZero(amount)) continue;
            rows.push(Object.assign({
                sign: SIGN_ORDERED,
                organizationId: doc.organizationId,
                bookingId: doc.UID,
                quantity,
                amount,
                // Сопроводительные реквизиты: цена — чтобы движение читалось
                // человеком, подпись — чтобы он узнал позицию в лицо.
                unitPrice: M.num(p.unitPrice),
                label: p.label || null
            }, position));
        }

        if (rows.length) await ctx.movements.write(bookingServices.REGISTER, rows);
    }

    /**
     * АВАНС НОВОЙ БРОНИ → ПОСТУПЛЕНИЕ.
     *
     * Сумма и способ лежат в самой брони (`firstPrepaymentAmount/Method`), пока
     * проведение не превратит их в документ. Охрана повтора — штамп
     * `firstPrepaymentReceiptId`, который ядро пишет в той же транзакции, что и
     * создание (`ctx.createOnce`): перепроведение, каскад и групповое проведение
     * второй документ не создадут, а удалённый — не воскресят.
     *
     * ДАТА — момент ВВОДА, то есть `createdAt` брони (серверное время), а не момент
     * проведения: наличные записываются днём поступления (§ 146 Abs. 1 Satz 2 AO), а
     * поля аванса видны только у новой брони. Из часов дата не берётся — повтор
     * после ошибки через полночь её не сдвигает (идемпотентность проведения, §73).
     */
    async function createFirstPrepaymentReceipt(doc, ctx) {
        if (M.isZero(M.num(doc.firstPrepaymentAmount))) return;
        const stamp = doc.firstPrepaymentReceiptId;
        if (stamp !== null && stamp !== undefined && String(stamp) !== '') return;
        if (M.cmp(M.num(doc.firstPrepaymentAmount), 0) < 0) {
            throw refuse('Отрицательный аванс', 'cash_err_negative_amount');
        }

        const table = 'cash_receipts';
        const code = paymentDocument.OPERATION_CODE[table];
        const opType = await paymentDocument.findOperationType({
            code, organizationId: doc.organizationId, sessionID: ctx.sessionID, gateway: ctx.dbGateway
        });
        if (!opType) throw refuse(`Вид операции «${code}» не найден`, 'prepay_err_no_optype', { code });

        const method = doc.firstPrepaymentMethod || 'cash';
        const place = await paymentDocument.placeFor({
            organizationId: doc.organizationId, method, sessionID: ctx.sessionID, gateway: ctx.dbGateway
        });
        if (!place) {
            throw refuse(`Нет места хранения для способа «${method}»`, 'booking_err_no_place_for_method');
        }

        const when = doc.createdAt ? new Date(doc.createdAt) : new Date(doc.date);
        await ctx.createOnce({
            table,
            stamp: 'firstPrepaymentReceiptId',
            values: {
                organizationId: doc.organizationId,
                hotelId: doc.hotelId || null,
                clientId: doc.clientId || null,
                bookingId: doc.UID,
                operationTypeId: opType.UID,
                paymentMethod: method,
                cashboxId: place.UID,
                amount: M.db(M.num(doc.firstPrepaymentAmount)),
                date: when,
                operationDate: when,
                sourceTable: 'bookings',
                sourceUID: doc.UID
            }
        });
    }

    return { postServices };
};
