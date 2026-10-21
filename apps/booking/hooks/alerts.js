'use strict';

/**
 * ПРАВИЛА ОПОВЕЩЕНИЙ ПО БРОНИ (ТЗ `tmp/ТЗ_ОПОВЕЩЕНИЯ_ПО_ДОКУМЕНТАМ.md`, §5, §15).
 *
 * Первый прикладной потребитель механизма оповещений. Два правила, и оба
 * отвечают на вопросы, которые до сих пор не задавал никто:
 *
 *   `booking.overInvoiced`  выставлено больше, чем заказано — нужна корректировка
 *                           (это и есть случай § 17 Abs. 1 UStG: гость уехал
 *                           раньше, а счёт уже выписан);
 *   `booking.notInvoiced`   гость выехал, а счёт не выставлен — прямая потеря денег.
 *
 * РАСЧЁТА ЗДЕСЬ НЕТ, и это главное: обе величины — ОСТАТОК РЕГИСТРА услуг по
 * брони, который считает общий модуль `apps/common/lib/bookingServices.js`. Тот
 * же модуль отвечает журналу броней и форме брони; своя копия признака
 * расхождения показывала бы разное про одну и ту же бронь.
 *
 * Правило НИЧЕГО НЕ УДАЛЯЕТ и не знает, что было раньше: старые строки снимает
 * ядро (`documentAlerts.rebuild`), и оповещение исчезает само, когда причина
 * устранена. Порядок строк обязан быть детерминированным — он и есть ключ
 * сопоставления при перезаписи (§7); здесь это обеспечено тем, что каждое
 * правило возвращает НЕ БОЛЕЕ ОДНОЙ строки.
 */

const path = require('path');
const FW = path.join(__dirname, '..', '..', '..', 'node_modules', 'my-old-space');

const M = require(path.join(FW, 'drive_root', 'db', 'money'));
const { isEmptyDate } = require(path.join(FW, 'drive_root', 'db', 'emptyValues'));
const dbGateway = require(path.join(FW, 'drive_root', 'dbGateway'));
const posting = require(path.join(FW, 'drive_root', 'db', 'posting'));
const deletionMark = require(path.join(FW, 'drive_root', 'db', 'deletionMark'));
const bookingServices = require('../../common/lib/bookingServices');
// «Отменена ли бронь» — один ответ на всю систему (см. lib/bookingStatus.js).
const bookingStatus = require('../lib/bookingStatus');

/**
 * Насколько давно выехавшие брони смотрит суточный проход.
 *
 * Окно, а не «вся история»: забытый счёт за позапрошлый год — это уже вопрос к
 * годовой отчётности, а не к утреннему напоминанию, и ежедневно перебирать
 * десять лет броней ради него нечестно по отношению к серверу. Окно при этом
 * заведомо длиннее любого разумного «забыл выставить».
 */
const DEPARTED_WINDOW_DAYS = 365;

module.exports = function (modelsDB, Utilities) {

    /** Деньги в текст: та же запись, что в пометке на форме брони. */
    function money(v) {
        return M.db(v) + ' €';
    }

    /** Остаток «что не выставлено» по одной брони, в разрезе позиций. */
    async function remainingOf(doc, ctx) {
        return await bookingServices.remaining({
            bookingIds: [doc.UID],
            sessionID: ctx.sessionID,
            // Внутри транзакции проведения: движения, только что записанные
            // обработчиком, обязаны быть видны — иначе правило посчитает остаток
            // по старым данным и запишет оповещение как верное.
            transaction: ctx.transaction || undefined
        });
    }

    /**
     * Счёт, в котором эта бронь выставлена, — самый поздний.
     *
     * Нужен ДЕЙСТВИЮ оповещения: корректировку выпускает счёт, а не бронь, и
     * без ссылки человек прочтёт «нужна корректировка» и пойдёт её искать
     * руками. Самый поздний — потому что именно он отражает текущее состояние
     * расчётов; порядок — по моменту времени документа `(date, seq)`, как и
     * везде в системе.
     */
    async function lastInvoiceOf(doc, ctx) {
        const opts = ctx.transaction ? { transaction: ctx.transaction } : {};
        const links = await dbGateway.execute({
            operation: 'read', table: 'invoice_bookings',
            where: { bookingId: doc.UID },
            options: Object.assign({ raw: true }, opts),
            context: Object.assign({ appName: 'booking', sessionID: ctx.sessionID },
                ctx.transaction ? { transaction: ctx.transaction } : {})
        }) || [];
        const ids = [...new Set(links.map(l => l.invoiceId).filter(Boolean))];
        if (!ids.length) return null;

        const invoices = await dbGateway.execute({
            operation: 'read', table: 'invoices',
            where: { UID: ids },
            options: Object.assign({ raw: true }, opts),
            context: Object.assign({ appName: 'booking', sessionID: ctx.sessionID },
                ctx.transaction ? { transaction: ctx.transaction } : {})
        }) || [];
        if (!invoices.length) return null;

        invoices.sort((a, b) => {
            const d = String(b.date || '').localeCompare(String(a.date || ''));
            if (d) return d;
            return Number(b.seq || 0) - Number(a.seq || 0);
        });
        return invoices[0];
    }

    /**
     * ВЫСТАВЛЕНО БОЛЬШЕ, ЧЕМ ЗАКАЗАНО.
     *
     * Признак — отрицательное КОЛИЧЕСТВО в остатке, а не отрицательная сумма
     * (`bookingServices.overInvoicedAmount`): сумма уходит в минус и от законной
     * правки цены в строке счёта, а пометка, срабатывающая на штатном действии,
     * перестаёт читаться — и, перестав читаться, пропускает тот самый случай,
     * ради которого заведена.
     *
     * Наружу отдаётся СУММА: человеку нужно «нужна корректировка на 67,00 €», а
     * не «минус одна ночь».
     */
    async function buildOverInvoiced(doc, ctx) {
        const remaining = await remainingOf(doc, ctx);
        let over = 0;
        for (const row of remaining.values()) {
            over = M.add(over, bookingServices.overInvoicedAmount(row));
        }
        if (M.isZero(over)) return [];

        const invoice = await lastInvoiceOf(doc, ctx);
        return [{
            // Тот же ключ, которым эта беда называлась на форме брони: текст один,
            // и переписывать его во втором месте значит однажды получить две
            // разные формулировки одного.
            text: 'over_invoiced_notice',
            vars: { amount: money(over) },
            action: invoice ? {
                kind: 'openRecord',
                app: 'invoice',
                params: { table: 'invoices', uid: invoice.UID },
                caption: 'booking_alert_open_invoice'
            } : null
        }];
    }

    /**
     * ГОСТЬ ВЫЕХАЛ, А СЧЁТ НЕ ВЫСТАВЛЕН.
     *
     * Правило ЗАВИСИТ ОТ ВРЕМЕНИ: вчера оповещения не было, сегодня есть, хотя в
     * базе ничего не менялось. Поэтому оно объявлено `timeDependent` и
     * пересчитывается суточным заданием — и ОДНОВРЕМЕННО остаётся обычным
     * правилом движений, чтобы исчезнуть в ту же секунду, когда счёт выставлен, а
     * не через сутки.
     *
     * Невыставленным считается положительный остаток регистра: «заказано» минус
     * «выставлено». Сравнения дат со счетами здесь нет и не нужно — остаток
     * отвечает на этот вопрос точнее, чем любая сверка в коде.
     */
    async function buildNotInvoiced(doc, ctx) {
        // Не выехал — говорить пока нечего. Пустая дата (0001-01-01) — не дата
        // выезда, а «не заполнено»: `if (doc.checkOut)` пропустил бы её как
        // заполненную (правило пустых значений проекта).
        if (isEmptyDate(doc.checkOut)) return [];
        // «Счёт не требуется» — человек решил, что по этой брони счёта не будет.
        // Напоминать о нём дальше значит спорить с этим решением каждое утро.
        if (doc.noInvoiceRequired) return [];
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (new Date(doc.checkOut) >= today) return [];

        const remaining = await remainingOf(doc, ctx);
        let notInvoiced = 0;
        for (const row of remaining.values()) {
            // Положительный остаток — заказано и не выставлено. Отрицательный —
            // это другая беда, и о ней говорит своё правило.
            if (M.cmp(row.quantity, 0) <= 0) continue;
            notInvoiced = M.add(notInvoiced, row.amount);
        }
        if (M.cmp(notInvoiced, 0) <= 0) return [];

        return [{
            text: 'booking_alert_not_invoiced',
            vars: { amount: money(notInvoiced) },
            // «Создать» открывает НЕСОХРАНЁННУЮ форму счёта, заполненную по этой
            // брони, — тот же путь, которым счёт создаётся кнопкой на её форме
            // (`prepareFromBooking` ничего не пишет в базу). Передумал и закрыл
            // окно — в базе не осталось ничего, ни черновика, ни занятого номера.
            action: {
                kind: 'openNew',
                app: 'invoice',
                params: {
                    table: 'invoices',
                    form: 'record:invoices',
                    method: 'prepareFromBooking',
                    params: { bookingId: doc.UID }
                },
                caption: 'booking_alert_create_invoice'
            }
        }];
    }

    /**
     * НЕТ ЦЕНЫ — номер на такое число гостей, вид гостя со своим тарифом или
     * услуга без цены в срезе прайс-листов на дату брони (16.10.2026).
     *
     * Раньше бронь без цены номера НЕ СОХРАНЯЛАСЬ: проверка в `onBeforeSave`
     * бросала ошибку. Владелец: «предупреждать, чтобы можно было сначала
     * сохранить, а потом идти разбираться в прайсы». Теперь бронь сохраняется,
     * а пометка висит на ней, пока цены нет, и уходит сама при следующем
     * проведении после правки прайс-листа.
     *
     * Расчёт — тот же общий модуль, что и у проведения: причины «нет цены» он
     * уже собирает (`skipped`), здесь они только становятся пометками. Тексты —
     * те же, что у предупреждений заполнения счёта (`apps/invoice/hooks/alerts.js`).
     */
    const PRICE_REASONS = {
        roomnoprice:  'room_no_price',
        guestnoprice: 'guest_type_no_price',
        noprice:      'service_skipped_no_price'
    };
    async function buildMissingPrices(doc, ctx) {
        // Отменённая бронь ничего не заказывала (см. lib/bookingStatus.js):
        // цена услуги, которая не будет оказана, никого не интересует.
        if (await bookingStatus.isCancelled(doc, ctx)) return [];
        const api = bookingServices(modelsDB, Utilities);
        const pricingDate = isEmptyDate(doc.date) ? new Date() : new Date(doc.date);
        const { skipped } = await api.orderedPositions({ bookingId: doc.UID, pricingDate }, ctx);
        const seen = new Set();
        const items = [];
        for (const s of (skipped || [])) {
            if (!s || !PRICE_REASONS[s.reason]) continue;
            const key = s.reason + '|' + (s.service || '');
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({ key, s });
        }
        // Порядок строк — ключ сопоставления при перезаписи: только явная сортировка.
        items.sort((a, b) => a.key.localeCompare(b.key));
        return items.map(({ s }) => ({
            text: PRICE_REASONS[s.reason],
            vars: Object.assign({
                service: s.service || '',
                gtDir: { i18n: 'guest_types' },
                gtField: { i18n: 'room_rate_mode' }
            }, s.vars || {}),
            action: {
                kind: 'openForm',
                app: 'priceList',
                params: { form: 'list:price_lists' },
                caption: 'booking_alert_open_price_lists'
            }
        }));
    }

    /**
     * КОГО СМОТРИТ СУТОЧНЫЙ ПРОХОД.
     *
     * Отбираются ВСЕ выехавшие в окне, а не только те, у кого счёта нет: правило
     * обязано получить и те брони, по которым оповещение пора СНЯТЬ. Отбор «только
     * проблемные» оставил бы снятую причину с висящей пометкой навсегда — это та же
     * ошибка, что «приложение удаляет оповещения само».
     *
     * Помеченные на удаление не отбираются: ядро всё равно снимет их оповещения, но
     * и считать по ним незачем.
     */
    async function selectDeparted(ctx) {
        const { Op } = require(require.resolve('sequelize', { paths: [FW] }));
        const from = new Date();
        from.setDate(from.getDate() - DEPARTED_WINDOW_DAYS);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const rows = await dbGateway.execute({
            operation: 'read', table: 'bookings',
            where: {
                checkOut: { [Op.gte]: from, [Op.lt]: today },
                // Непроведённая бронь ничего не заказывала: остаток по ней пуст,
                // и спрашивать регистр не о чем.
                [posting.STATE_FIELD]: posting.STATE.POSTED,
                [deletionMark.FIELD]: false
            },
            options: { raw: true, attributes: ['UID'] },
            context: { appName: 'booking', sessionID: ctx.sessionID }
        }) || [];

        return rows.map(r => ({ table: 'bookings', uid: r.UID }));
    }

    return { buildOverInvoiced, buildNotInvoiced, buildMissingPrices, selectDeparted, DEPARTED_WINDOW_DAYS };
};
