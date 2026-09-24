'use strict';

/**
 * Проведение денежных документов (ТЗ «Проведение документов», §9.2, §19 этап 10).
 *
 * Приложение пишет ТОЛЬКО проведение. Распроведения здесь нет и быть не может:
 * движения принадлежат документу-регистратору, и снимает их ядро само
 * (`drive_root/db/posting.js#clearMovements`). Именно поэтому отмена не может
 * разойтись с проведением — её никто не пишет.
 *
 * Обработчики — ИМЕНОВАННЫЕ функции, а не анонимные замыкания: имя видно в
 * объявлении документа (`entityConfig.posting.handler`), в журнале и в стеке
 * ошибки. Замыкание в таком API не отлаживается.
 *
 * Момент времени, регистратор и номер строки проставляет ядро — обработчику
 * остаётся сказать ЧТО и КУДА движется.
 *
 * ── Правовое ──────────────────────────────────────────────────────────────────
 * Эти документы фиксируют факт оплаты ПОСЛЕ того, как она состоялась. Программа
 * не принимает платёж в момент расчёта, не печатает гостю чек, не управляет
 * денежным ящиком и не делает Z-отчёт — поэтому § 146a AO (KassenSichV, TSE) к
 * ней не применяется, и это ровно та граница, которую нельзя переходить
 * (ТЗ §17.2). Что применяется и соблюдается: одна операция — один документ
 * (§ 146 Abs. 1 AO, свёртка нескольких платежей запрещена), запись неизменна
 * (`entityConfig.immutable`) и прослеживаема (`auditLog`), а карточные обороты
 * отличимы от наличных полем `paymentMethod` и местом хранения.
 */

const money = require('../../../node_modules/my-old-space/drive_root/db/money');
const { PostingError } = require('../../../node_modules/my-old-space/drive_root/db/posting');

/**
 * Отказ провести документ.
 *
 * Причина видна ПОЛЬЗОВАТЕЛЮ — в уведомлении и в пометке на форме, — поэтому у
 * неё есть ключ перевода. Технический текст остаётся в сообщении: он идёт в
 * журнал сервера, где нужен как есть.
 */
function refuse(message, key, vars) {
    return new PostingError('[cash] ' + message, 'CASH_POSTING', key, vars || {});
}

/** Знак движения по виду документа. Приход кладёт деньги, расход снимает. */
const SIGN_IN = +1;
const SIGN_OUT = -1;

/**
 * Сумма документа, пригодная для записи в регистр.
 *
 * `DECIMAL` приходит из драйвера СТРОКОЙ, а с формы — числом. Собственное
 * округление разошлось бы с серверным на половине цента, поэтому только money.js.
 * Нулевая сумма — не ошибка записи, а бессмысленное движение: документ на ноль
 * ничего не меняет, и пустая строка в регистре только мешала бы читать остаток.
 */
function amountOf(doc, field) {
    const v = money.num(doc[field || 'amount']);
    return money.round(v);
}

/**
 * ВЗАИМОРАСЧЁТЫ С КЛИЕНТОМ — второй регистр того же документа.
 *
 * Деньги и долги — разные вопросы, и разрезы у них разные: касса разрезается по
 * месту хранения, расчёты — по клиенту. Поэтому не ещё одно измерение у денег, а
 * отдельный регистр (решение владельца 23.09.2026).
 *
 * ЧТО ИМЕННО ПОРОЖДАЕТ ОПЕРАЦИЯ — ДАННЫЕ, а не код: вид расчётов объявлен у вида
 * операции (`cash_operation_types.settlementKind`). Новый вид операции заводится
 * в справочнике, а не правкой этого файла.
 *
 * ЗНАК. Одно правило на оба вида документа, симметричное:
 *   деньги ПРИШЛИ  → долг клиента уменьшается (−), предоплата/залог растут (+);
 *   деньги УШЛИ    → долг растёт (+), предоплата/залог уменьшаются (−).
 * Отсюда читается остаток: `debt` > 0 — клиент должен нам; `prepayment` > 0 — мы
 * держим его предоплату (наш долг услугой); `deposit` > 0 — держим залог.
 *
 * Без клиента движения нет и быть не может: расчёты ведутся С КЕМ-ТО. Комиссия
 * банка и перенос между своими кассами клиента не имеют — и правильно.
 */
async function writeSettlement(doc, ctx, moneySign) {
    if (!doc.clientId) return;

    const kind = await settlementKindOf(doc, ctx);
    if (!kind || kind === 'none') return;

    const amount = amountOf(doc, 'amount');
    if (money.isZero(amount)) return;

    // Долг и «удержания» ведут себя зеркально: пришедшие деньги гасят долг, но
    // увеличивают предоплату.
    const sign = (kind === 'debt') ? -moneySign : moneySign;

    await ctx.movements.write('reg_settlements', [{
        sign,
        organizationId: doc.organizationId,
        clientId: doc.clientId,
        settlementKind: kind,
        amount,
        comment: doc.comment || null
    }]);
}

/** Вид расчётов, объявленный у вида операции документа. */
async function settlementKindOf(doc, ctx) {
    if (!doc.operationTypeId) return 'debt';
    try {
        const rows = await ctx.dbGateway.execute({
            operation: 'read', table: 'cash_operation_types',
            where: { UID: doc.operationTypeId },
            options: { raw: true, limit: 1 }
        });
        const row = rows && rows[0];
        return (row && row.settlementKind) || 'debt';
    } catch (e) {
        // Справочник не прочитался — считаем обычным долгом: это самый частый
        // случай, и молча ПРОПУСТИТЬ движение было бы хуже, чем записать не тем
        // видом (остаток сойдётся, разрез можно поправить).
        console.error('[cash] вид расчётов не прочитан:', e && e.message);
        return 'debt';
    }
}

/** Общая часть прихода и расхода: одно движение по кассе документа. */
async function writeSingleMovement(doc, ctx, sign) {
    const amount = amountOf(doc, 'amount');
    if (money.isZero(amount)) {
        throw refuse('Сумма документа равна нулю — проводить нечего', 'cash_err_zero_amount');
    }
    if (!doc.cashboxId) {
        throw refuse('Не указано место хранения денег', 'cash_err_no_cashbox');
    }
    await ctx.movements.write('reg_cash', [{
        sign,
        organizationId: doc.organizationId,
        cashboxId: doc.cashboxId,
        amount,
        paymentMethod: doc.paymentMethod || null,
        operationTypeId: doc.operationTypeId || null,
        // Клиент КОПИРУЕТСЯ в движение, а не добирается потом соединением с
        // документом: регистр обязан быть самодостаточным. Отчёт, которому нужен
        // клиент, не должен знать, из какого вида документа взялась строка, —
        // иначе каждый новый вид документа ломает каждый существующий отчёт.
        clientId: doc.clientId || null,
        comment: doc.comment || null
    }]);
}

/** Поступление денежных средств. */
async function postReceipt(doc, ctx) {
    await writeSingleMovement(doc, ctx, SIGN_IN);
    await writeSettlement(doc, ctx, SIGN_IN);
}

/** Списание денежных средств. */
async function postPayment(doc, ctx) {
    await writeSingleMovement(doc, ctx, SIGN_OUT);
    await writeSettlement(doc, ctx, SIGN_OUT);
}

/**
 * Перенос между местами хранения (зачисление с терминала на счёт).
 *
 * ОДИН документ — ОДНА операция (§ 146 Abs. 1 AO). Гость заплатил 100 €, через
 * два дня на счёт пришло 98,50 €; в банковской выписке это ОДНО зачисление, и
 * изображать его двумя было бы выдумкой.
 *
 * Движений при этом ДВА, а не три:
 *     «в пути»  −100,00      (столько ушло оттуда)
 *     счёт      +98,50       (столько туда пришло)
 *
 * Третье движение на комиссию было бы ОШИБКОЙ на её величину: регистр учитывает
 * МЕСТА ХРАНЕНИЯ денег, а удержанная комиссия ни в каком месте не лежит — она
 * ушла из системы, и разница между двумя движениями и есть она сама. Списать её
 * ещё раз значило бы получить остаток на 1,50 € меньше реального, причём
 * совершенно молча.
 *
 * Отдельной записью комиссия остаётся там, где она и нужна, — реквизитом
 * документа (`feeAmount`) и отдельной строкой в кассовой книге. Так «выписка
 * сходится с оплатами» (ТЗ §17.4) без выдуманных движений.
 */
async function postTransfer(doc, ctx) {
    const amount = amountOf(doc, 'amount');
    const fee = amountOf(doc, 'feeAmount');

    if (money.isZero(amount)) {
        throw refuse('Сумма переноса равна нулю — переносить нечего', 'cash_err_zero_transfer');
    }
    if (!doc.fromCashboxId || !doc.toCashboxId) {
        throw refuse('Не указано место хранения (откуда или куда)', 'cash_err_no_transfer_box');
    }
    if (doc.fromCashboxId === doc.toCashboxId) {
        throw refuse('Перенос в то же самое место хранения ничего не меняет', 'cash_err_same_box');
    }

    // ОТРИЦАТЕЛЬНАЯ КОМИССИЯ — отказ, и проверять её надо ДО вычитания.
    //
    // Комиссия вычитается (`получено = сумма − комиссия`), поэтому минус в ней
    // не уменьшает, а УВЕЛИЧИВАЕТ приход: комиссия −50 при сумме 100 даёт
    // движения −100 «откуда» и +150 «куда», то есть полсотни евро, которых не
    // было, молча оседают в остатке кассы и в конечном остатке кассовой книги.
    // Проверка «получено < 0» ниже этого НЕ ловит: 150 больше нуля.
    //
    // Запрет стоит и на форме (`cash_documents.server.js#onBeforeSave`, список
    // MONEY_FIELDS), но здесь он обязан быть тоже: форма — не единственный путь
    // записи, а инвариант регистра держит проведение.
    if (money.cmp(fee, 0) < 0) {
        throw refuse('Комиссия не может быть отрицательной', 'cash_err_negative_fee');
    }

    // Сколько реально дошло: комиссия удерживается по дороге.
    const received = money.sub(amount, fee);
    if (money.cmp(received, 0) < 0) {
        throw refuse('Комиссия больше суммы переноса', 'cash_err_fee_too_big');
    }

    const rows = [
        { sign: SIGN_OUT, cashboxId: doc.fromCashboxId, amount },
        { sign: SIGN_IN, cashboxId: doc.toCashboxId, amount: received }
    ];

    await ctx.movements.write('reg_cash', rows.map(r => ({
        sign: r.sign,
        organizationId: doc.organizationId,
        cashboxId: r.cashboxId,
        amount: r.amount,
        paymentMethod: null,
        operationTypeId: null,
        // У переноса между своими местами хранения клиента нет и быть не может.
        clientId: null,
        comment: doc.comment || null
    })));
}

/**
 * ПРОВЕРОЧНЫЙ ДОКУМЕНТ КАСКАДА (ТЗ §11.6).
 *
 * Единственный документ в системе, который ЧИТАЕТ регистр при проведении, —
 * и поэтому единственный, на ком каскад перепроведения вообще проверяем.
 * Денежные документы независимы (контроля отрицательного остатка нет, решение
 * владельца), так что без него механизм был бы построен и не сработал ни разу,
 * а первая настоящая зависимость поехала бы в бой непроверенной.
 *
 * Что делает: спрашивает остаток кассы НА СВОЙ МОМЕНТ ВРЕМЕНИ и записывает
 * прочитанное в собственный реквизит. Отсюда полная наблюдаемость: правка
 * раннего документа обязана изменить `balanceAtMoment` у всех проверочных
 * документов ПОЗЖЕ неё и не тронуть тех, кто раньше.
 *
 * Запись в САМ документ идёт через шлюз с транзакцией проведения — иначе
 * прочитанное значение и движения могли бы лечь порознь.
 */
async function postCheck(doc, ctx) {
    const path = require('path');
    const FW = path.join(__dirname, '..', '..', '..', 'node_modules', 'my-old-space');
    const registers = require(path.join(FW, 'drive_root', 'db', 'registers'));

    // Остаток СТРОГО на момент этого документа: именно он меняется, когда
    // раньше по времени что-то исправили.
    const rows = await registers.balance({
        register: 'reg_cash',
        dimensions: { cashboxId: doc.cashboxId, organizationId: doc.organizationId },
        moment: ctx.moment,
        context: { sessionID: ctx.sessionID, transaction: ctx.transaction }
    });
    const balance = money.round(money.num((rows && rows[0] && rows[0].amount) || 0));

    await ctx.dbGateway.execute({
        operation: 'update',
        table: ctx.table,
        where: { UID: ctx.uid },
        data: { balanceAtMoment: balance, postCount: Number(doc.postCount || 0) + 1 },
        options: { transaction: ctx.transaction },
        context: { sessionID: ctx.sessionID, transaction: ctx.transaction }
    });

    // Копеечное движение — чтобы документ был не только читателем, но и
    // писателем: иначе он не поднимал бы каскад для тех, кто позже него,
    // и проверить рекурсию было бы нечем.
    await ctx.movements.write('reg_cash', [{
        sign: +1,
        organizationId: doc.organizationId,
        cashboxId: doc.cashboxId,
        amount: 0.01,
        comment: 'cascade check'
    }]);
}

module.exports = { postReceipt, postPayment, postTransfer, postCheck };
