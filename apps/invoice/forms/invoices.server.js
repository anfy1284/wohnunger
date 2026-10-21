'use strict';

// Серверные функции формы «Счёт» (документ invoices).
//
// Экспортирует фабрику: module.exports = function(modelsDB, Utilities) { return { ... }; }
// Вызывается из init.js: loadServerScript('invoice.actions', require('./invoices.server')(modelsDB, Utilities), 'user')
//
// Каждая функция получает (params, ctx) где ctx = { sessionID, user, role }.
//
// Расчёт состава услуг и свёртка строк живут в apps/common/lib/bookingServices.js:
// тот же состав нужен проведению брони («что заказано» в регистр), и два расчёта
// одного и того же разошлись бы — вопрос только когда. Счёт при этом остаётся
// самостоятельным документом: он решает, ЧТО из состава попадёт в документ
// (кнопка «Заполнить» / создание из брони), и сохранение брони его не трогает.

// Деньги: суммы хранятся как DECIMAL и приходят из базы СТРОКОЙ, а считаются
// в целых центах. Любая арифметика над суммами — только через этот модуль.
const M = require('../../../node_modules/my-old-space/drive_root/db/money');
// Предоплата брони — остаток регистра расчётов, а не поле брони.
const settlementBalance = require('../../common/lib/settlementBalance');
// Состав услуг по брони: расчёт, свёртка и КЛЮЧ ПОЗИЦИИ (один на всю систему).
const bookingServices = require('../../common/lib/bookingServices');
const { tForSession, tfForSession, getSessionContext } = require('../../../node_modules/my-old-space/drive_forms/globalServerContext');
const { resolveOrgPricingMode } = require('../../common/lib/orgPricingMode');
// Локаль форматирования по коду языка — один список на решение.
const locale = require('../../common/lib/locale');
// «Отменена ли бронь» — один ответ на всю систему.
const bookingStatus = require('../../booking/lib/bookingStatus');
const dbGateway = require('../../../node_modules/my-old-space/drive_root/dbGateway');
// Сборка печатной формы — общая с приложением reports: архив обязан хранить
// ровно тот HTML, который увидит пользователь, а не его пересборку.
const { buildInvoiceDoc } = require('../../reports/invoice/build');
// Архив выставленных документов — механизм ЯДРА, не приложения. Сторно и
// коррекция тоже: их делают команды ядра (drive_root/db/documentCommands.js),
// приложение объявляет их в db.json и даёт хук выставления.
const documentArchive = require('../../../node_modules/my-old-space/drive_root/db/documentArchive');
// Пустая дата — это 0001-01-01, а не NULL (правило проекта, см.
// drive_root/db/emptyValues.js). Проверять заполненность даты через
// `if (r.validTo)` НЕЛЬЗЯ: 0001-01-01 — истинное значение, и такая
// проверка объявит период действия истёкшим.
const { isEmptyDate } = require('../../../node_modules/my-old-space/drive_root/db/emptyValues');

// Периоды действия (validFrom..validTo) — из общего модуля: пустая граница
// означает «ограничения нет», и проверять её через `if (r.validTo)` НЕЛЬЗЯ
// (пустая дата в проекте — 0001-01-01, значение истинное; такая проверка
// объявила бы период истёкшим, то есть каждая ставка НДС без даты окончания
// перестала бы применяться, а счета остались бы без налога).
const { periodCovers, validFromOrder } = bookingServices;

/**
 * ПРЕДЕЛ ПРЕДОПЛАТЫ В СЧЁТЕ — сумма, которую счёт просит заплатить.
 *
 * Счёт не возвращает деньги: зачесть в него аванса больше, чем начислено,
 * значит напечатать отрицательный «Zahlbetrag» и зачесть по регистру больше,
 * чем счётом начислено. Излишек остаётся остатком предоплаты по брони и
 * достанется следующему счёту.
 *
 * ЗНАК ОБЯЗАТЕЛЕН в этом правиле. У сторно и коррекции суммы отрицательны, и
 * предел там тоже отрицательный: сравнение «по величине» (`v > t`) выдержало
 * бы обычный счёт и молча обнулило бы предоплату сторно. Поэтому ограничение
 * двустороннее — значение зажимается в отрезок между нулём и итогом, каким бы
 * знаком этот итог ни был.
 *
 * @param {number|string} value — предоплата, которую хотят записать
 * @param {number|string} total — итог счёта (брутто после скидки), как он печатается
 * @returns {number} допустимое значение предоплаты
 */
function capPrepayment(value, total) {
    const v = M.round(M.num(value));
    const t = M.round(M.num(total));
    if (M.isZero(t)) return 0;                                // платить нечего — зачитывать нечего
    if (M.cmp(t, 0) > 0) return M.cmp(v, t) > 0 ? t : (M.cmp(v, 0) < 0 ? 0 : v);
    return M.cmp(v, t) < 0 ? t : (M.cmp(v, 0) > 0 ? 0 : v);   // встречный документ: отрезок [итог, 0]
}

module.exports = function (modelsDB, Utilities) {

    // Цены проживания и услуг — ТОЛЬКО через резолвер прайс-листов.
    const priceResolver = require('../../common/lib/priceResolver')(modelsDB);

    // Состав услуг по брони и свёртка печатных строк — общие с проведением брони.
    const services = bookingServices(modelsDB, Utilities);

    /**
     * СУММА, КОТОРУЮ СЧЁТ ПРОСИТ ЗАПЛАТИТЬ (до вычета аванса) — по тем же
     * правилам, по которым она печатается: расчёт один, в `reports/invoice/totals.js`.
     *
     * Нужна там, где предоплату подставляет ПРОГРАММА (подготовка счёта из
     * брони, «Заполнить»): подставленное число обязано быть допустимым.
     * Признак «на этот оборот скидка распространяется» — данные справочника,
     * поэтому категории строк дочитываются здесь.
     *
     * @param {Array} lines — строки счёта (`amount`, `taxCategoryId`, `bookingId`)
     * @param {Object} invoice — скидка на весь счёт (`discountMode`, `discountValue`)
     * @param {Array} [bookingDiscounts] — строки ТЧ «Buchungen» со скидками броней
     */
    async function _payableTotal(lines, invoice, bookingDiscounts) {
        const { invoiceTotals } = require('../../reports/invoice/totals');
        const taxCategories = {};
        try {
            const ids = [...new Set((lines || []).map(l => l && l.taxCategoryId).filter(Boolean))];
            if (ids.length && modelsDB.TaxCategories) {
                const cats = await modelsDB.TaxCategories.findAll({ where: { UID: ids }, raw: true });
                for (const c of cats) taxCategories[c.UID] = { discountable: c.discountable !== false };
            }
        } catch (e) {
            console.warn('[invoice/_payableTotal] категории строк не дочитаны:', e && e.message || e);
        }
        return invoiceTotals({ lines: lines || [], invoice: invoice || {}, taxCategories,
                               bookingDiscounts: bookingDiscounts || [] }).discountedBrutto;
    }

    // SSE-оповещение подписанных списков (журнал счетов, вкладка «Счета» брони).
    // fillInvoice/createFromBooking меняют данные мимо applyChanges — оповещаем сами.
    function notifyTables(action, invoiceId) {
        try {
            const uniForm = require('../../../node_modules/my-old-space/apps/uniForm/server.js');
            uniForm.notifyTableChange('invoices', action, invoiceId);
            uniForm.notifyTableChange('invoice_bookings', action, null);
            uniForm.notifyTableChange('invoice_lines', action, null);
        } catch (e) {
            console.warn('[invoice/notifyTables]', e && e.message);
        }
    }

    // Сообщение «эти услуги брони в счёт не попали» — UI-алерт пользователю,
    // поэтому на языке СЕССИИ (в отличие от строк счёта — они на языке организации).
    const SKIPPED_REASON_KEYS = {
        auto:         'service_skipped_auto',
        noprice:      'service_skipped_no_price',
        manual:       'service_manual_quantity_differs',
        // Не только услуги: сюда же попадают вид гостя с заявленной, но не
        // заведённой ценой и комната без цены на такое число гостей.
        guestnoprice: 'guest_type_no_price',
        roomnoprice:  'room_no_price'
    };

    async function _skippedNotice(skipped, sessionID) {
        if (!skipped || !skipped.length) return null;
        // Сообщение обязано показать, ГДЕ лежит правило, а не просто сослаться на него:
        // владелец не видел ни формулы, ни поля. Названия справочника и реквизита
        // берём из ТЕХ ЖЕ ключей i18n, что и сам интерфейс, — иначе подсказка
        // однажды начнёт называть поле не так, как оно подписано на экране.
        const dirName   = await tForSession('services', sessionID);
        const fieldName = await tForSession('quantity_formula', sessionID);
        // Те же имена, но для справочника видов гостей — сообщение обязано
        // показать, ГДЕ лежит правило, а не просто сослаться на него.
        const gtDir     = await tForSession('guest_types', sessionID);
        const gtField   = await tForSession('room_rate_mode', sessionID);
        const parts = [];
        for (const s of skipped) {
            const key = SKIPPED_REASON_KEYS[s.reason] || SKIPPED_REASON_KEYS.noprice;
            const vars = Object.assign(
                { service: s.service, dir: dirName, field: fieldName, gtDir, gtField }, s.vars || {});
            parts.push('• ' + await tfForSession(key, sessionID, vars));
        }
        return await tForSession('services_skipped_title', sessionID) + '\n' + parts.join('\n');
    }

    /**
     * ОСТАВИТЬ ТОЛЬКО НЕВЫСТАВЛЕННОЕ (ТЗ «Учёт услуг по брони», §7).
     *
     * Состав услуг отвечает, ЧТО называется и сколько стоит; регистр —
     * СКОЛЬКО из этого ещё не выставлено. Поэтому строка не просто проходит
     * или не проходит: её количество урезается остатком, и сумма пересчитывается
     * под урезанное количество (`Menge × Einzelpreis` обязано давать
     * напечатанную сумму, § 14 Abs. 4 Nr. 5 UStG).
     *
     * Защита от двойного выставления здесь АРИФМЕТИЧЕСКАЯ: второй счёт по той же
     * брони видит остаток, уже уменьшенный проведением первого, и предложить то
     * же самое ему просто нечем. Проверки «а не выставлено ли это уже» в коде
     * нет и не должно быть — она была бы второй правдой рядом с остатком.
     *
     * Собственные движения заполняемого счёта из остатка ИСКЛЮЧАЮТСЯ: он их
     * сейчас перепишет, и считать их выставленными значило бы предложить ему
     * пустоту (случай «админ вернул выставленный счёт в черновик» — состояние
     * сменилось, а движения остались).
     *
     * Несколько строк печати могут делить одну позицию учёта (цена в ключ
     * позиции не входит — см. `bookingServices.POSITION_FIELDS`). Тогда остаток
     * расходится по ним в порядке строк: иного основания предпочесть одну
     * другой у механизма нет, а выдумывать его — значит прятать произвол в код.
     *
     * @returns {Promise<{lines: Array, droppedCount: number}>}
     */
    async function _limitToRemaining(lines, { bookingIds, invoiceId, sessionID }) {
        const remaining = await bookingServices.remaining({
            bookingIds,
            excludeRecorder: invoiceId ? { table: 'invoices', uid: invoiceId } : null,
            sessionID
        });

        // Рабочие остатки: уменьшаются по мере раздачи строкам.
        const left = new Map();
        for (const [key, row] of remaining.entries()) left.set(key, row.quantity);

        const out = [];
        let droppedCount = 0;
        for (const ln of lines) {
            const key = bookingServices.keyOf(ln, ln.bookingId);
            const avail = left.has(key) ? left.get(key) : 0;
            // Остаток не больше нуля — позиция уже выставлена (или выставлена
            // с избытком, и это разбирается корректировкой, а не новым счётом).
            if (M.cmp(avail, 0) <= 0) { droppedCount++; continue; }

            const want = M.num(ln.quantity);
            const take = (M.cmp(avail, want) < 0) ? avail : want;
            left.set(key, M.sub(avail, take));

            if (M.cmp(take, want) !== 0) {
                // Количество урезано — сумму пересчитываем от ЦЕНЫ, а не делим
                // прежнюю сумму: печатается именно произведение.
                ln.quantity = take;
                ln.amount = M.mul(ln.unitPrice, take);
            }
            out.push(ln);
        }
        return { lines: out, droppedCount };
    }

    // ── Перезаполнение строк счёта по ТЧ «Бронирования» ──────────────────
    // Режим даты ценообразования — из настроек организации (pricingDateMode):
    //   bookingDate → дата документа каждой брони (своя на бронь);
    //   invoiceDate → дата документа счёта (одна на весь счёт).
    // Старые строки удаляются, новые пишутся; prepayment счёта = Σ prepayment
    // броней (только при заполнении — дальше пользователь правит сам).
    async function _fillInvoice(invoiceId, ctx) {
        const invoice = await modelsDB.Invoices.findByPk(invoiceId, { raw: true });
        if (!invoice) throw new Error(await tForSession('invoice_not_found', ctx.sessionID));

        const links = await modelsDB.InvoiceBookings.findAll({
            where: { invoiceId }, order: [['createdAt', 'ASC']], raw: true
        });
        const bookingIds = [...new Set(links.map(l => l.bookingId).filter(Boolean))];

        const mode = await resolveOrgPricingMode(modelsDB, invoice.organizationId);
        const taxRateRows = await modelsDB.TaxRates.findAll({ raw: true });

        const allLines = [];
        let prepaymentSum = 0;
        const bookingDiscounts = [];
        const allSkipped = [];
        for (const bookingId of bookingIds) {
            const booking = await modelsDB.Bookings.findByPk(bookingId, { raw: true });
            if (!booking) continue;
            const pricingDate = (mode === 'invoiceDate')
                ? (invoice.date || new Date())
                : (booking.date || invoice.date || new Date());
            const { lines, skipped, invLang } = await services.buildLines({ bookingId, pricingDate }, ctx);
            for (const s of (skipped || [])) {
                if (!allSkipped.some(x => x.service === s.service && x.reason === s.reason)) allSkipped.push(s);
            }
            // Предоплата брони не хранится в ней: это остаток регистра расчётов
            // по этой броне (apps/common/lib/settlementBalance.js). Спрашиваем там
            // же, где её спрашивает форма брони, — иначе счёт и бронь показали бы
            // разные числа про одну и ту же сумму.
            prepaymentSum = M.add(prepaymentSum, await settlementBalance.ofBooking({
                bookingId, sessionID: ctx.sessionID
            }));

            // СКИДКА БРОНИ — в строку этой брони в ТЧ «Buchungen» и только на её
            // строки (решение владельца 19.10.2026, apps/reports/invoice/totals.js).
            // Раньше скидки броней сводились в одну скидку шапки, и в общем счёте на
            // брони с 10 % и 0 % гость второй брони получал чужую скидку (прогон
            // 17.10.2026, Q3b). Ненулевая скидка в строке — решение человека, её
            // перезаполнение не затирает; ноль — «не заполнено».
            const link = links.find(l => l.bookingId === bookingId);
            if (link) {
                if (!M.num(link.discountValue) && Number(booking.discountValue)) {
                    link.discountMode  = booking.discountMode || 'percent';
                    link.discountValue = M.db(booking.discountValue);
                    await dbGateway.execute({
                        operation: 'update', table: 'invoice_bookings', where: { UID: link.UID },
                        data: { discountMode: link.discountMode, discountValue: link.discountValue },
                        context: { sessionID: ctx.sessionID }
                    });
                }
                bookingDiscounts.push(link);
            }

            // ТЧ хранит свёрнутые «печатные» строки (WYSIWYG) — детализация по
            // возрастным группам схлопывается здесь же, как раньше в печати.
            allLines.push(...services.collapse(lines, taxRateRows, invLang));
        }

        // В счёт попадает только НЕВЫСТАВЛЕННОЕ: сколько именно — отвечает
        // регистр, а не сверка со старыми счетами в коде.
        const limited = await _limitToRemaining(allLines, {
            bookingIds, invoiceId, sessionID: ctx.sessionID
        });
        allLines.length = 0;
        allLines.push(...limited.lines);
        const fromBookingsCount = allLines.length;

        // СТРОКИ ВНЕ БРОНИ ОСТАЮТСЯ (решение владельца 21.10.2026). Строку без
        // брони дописал в счёт человек: бронь её не заказывала, в регистр услуг
        // она не пишется (`writeServicesIssued`), и пересчёт «по броням» ей не
        // источник — стереть её значило бы потерять то, что заполнение заново
        // не вернёт. Ручная правка строки ИЗ брони по-прежнему перезаписывается:
        // у неё источник есть.
        const kept = await modelsDB.InvoiceLines.findAll({
            where: { invoiceId }, order: [['sortOrder', 'ASC']], raw: true
        });
        for (const ln of (kept || [])) {
            if (ln.bookingId) continue;
            const copy = Object.assign({}, ln);
            delete copy.createdAt; delete copy.updatedAt;
            // Подписи ссылочных ячеек — как у заполненных строк (`collapse`),
            // иначе форма после «Заполнить» показала бы в них UID.
            const rr = copy.taxRateId ? taxRateRows.find(r => r.UID === copy.taxRateId) : null;
            if (rr) copy.__taxRateId_display = rr.name;
            if (copy.serviceId) {
                const svc = await modelsDB.Services.findByPk(copy.serviceId, { raw: true });
                if (svc) copy.__serviceId_display = svc.name;
            }
            allLines.push(copy);
        }

        allLines.forEach((ln, i) => {
            ln.invoiceId = invoiceId;
            ln.sortOrder = i + 1;
            if (!ln.organizationId) ln.organizationId = invoice.organizationId;
        });

        // Перезапись строк — через dbGateway (RLS/хуки), не прямым Model.destroy/bulkCreate.
        // __*_display-ключи — только для формы, в БД не пишем.
        const dbCtx = { sessionID: ctx.sessionID };
        await dbGateway.execute({ operation: 'delete', table: 'invoice_lines', where: { invoiceId }, context: dbCtx });
        for (const ln of allLines) {
            const dbRow = {};
            for (const k of Object.keys(ln)) { if (!k.startsWith('__')) dbRow[k] = ln[k]; }
            await dbGateway.execute({ operation: 'create', table: 'invoice_lines', data: dbRow, context: dbCtx });
        }
        // Предоплата: ненулевое значение В СЧЁТЕ сильнее пересчёта. Это либо
        // реально полученные деньги, либо принятое решение пользователя, и
        // перезаполнение строк — не повод его затирать: раньше «Заполнить»
        // безусловно записывало Σ по броням, и на счёте 1399 так пропали
        // введённые вручную 100 € (в брони-основании стоял ноль).
        // Ноль в счёте читаем как «не заполнено» — тогда подтягиваем сумму
        // предоплат всех броней-оснований.
        // Скидка в шапке — дополнительная скидка на весь счёт: заполнение её не
        // трогает (скидки броней легли в строки «Buchungen» выше).
        const keepPrepayment = (Number(invoice.prepayment) || 0) !== 0;

        // ПРЕДОПЛАТА — ПОСЛЕ скидки и НЕ БОЛЬШЕ, ЧЕМ СЧЁТ ПРОСИТ ЗАПЛАТИТЬ.
        //
        // Остаток предоплат по броням бывает больше этого счёта: клиент внёс
        // аванс за весь заезд, а счёт выставляется на часть, либо аванс просто
        // больше суммы. Записать в счёт всё значило бы напечатать отрицательный
        // «Zahlbetrag» — счёт, который возвращает деньги, — и зачесть при
        // проведении больше, чем счётом начислено (прогон 16.10.2026: счёт на
        // 457,00 зачёл 20 050,00). Излишек НИКУДА НЕ ДЕВАЕТСЯ: он остаётся
        // остатком предоплаты по брони, и его возьмёт следующий счёт.
        //
        // Предел — то же число, которое печатается («сумма к оплате» до вычета
        // аванса): берём его у СБОРЩИКА печатной формы, а не считаем здесь
        // заново, иначе появился бы второй счёт-калькулятор.
        if (!keepPrepayment) {
            let value = prepaymentSum;
            try {
                value = capPrepayment(value, await _payableTotal(allLines, invoice, bookingDiscounts));
            } catch (e) {
                console.error('[invoice/_fillInvoice] предел предоплаты не определён:', e && e.message || e);
            }
            await dbGateway.execute({
                operation: 'update', table: 'invoices',
                where: { UID: invoiceId }, data: { prepayment: M.db(value) },
                context: dbCtx
            });
        }

        notifyTables('update', invoiceId);

        // ОПОВЕЩЕНИЯ СЧЁТА (ТЗ оповещений §15): предупреждения расчёта перестают
        // быть одноразовыми. Диалог ниже остаётся — это ответ на нажатие кнопки,
        // а оповещение живёт на счёте, пока причина не устранена, и видно в
        // журнале значком.
        //
        // Переписываются только строки СВОЕГО правила: то, что записало
        // проведение, заполнение задеть не вправе. Удалять оповещения приложение
        // не умеет и не должно — пустой список причин снимет их само ядро.
        try {
            const documentAlerts = require('../../../node_modules/my-old-space/drive_root/db/documentAlerts');
            await documentAlerts.rebuild({
                table: 'invoices', uid: invoiceId,
                ruleCodes: ['invoice.fillWarnings'],
                input: { skipped: allSkipped },
                sessionID: ctx.sessionID,
                requestedBy: (ctx.user && ctx.user.UID) || null
            });
            // ПУША ЗДЕСЬ НЕТ — и это не забывчивость.
            //
            // Заполнение счёта нажал человек, который прямо сейчас смотрит на эту
            // форму: он получает те же слова ответом на кнопку (диалог ниже) и
            // третий раз видит их в панели оповещений формы. Пуш был четвёртой
            // копией одной фразы — прогон 16.10.2026 так и записал: «один текст
            // двумя каналами». Две копии одной фразы — дефект, а не
            // подстраховка; уведомление нужно тому, кого в этот момент у формы
            // нет. Отметка об отправке при этом НЕ ставится: оповещение остаётся
            // «не сказанным», и если причина доживёт до чужого пересчёта, оно
            // уйдёт тому, кто о ней ещё не знает.
            notifyTables('update', invoiceId);
            require('../../../node_modules/my-old-space/apps/uniForm/server.js')
                .notifyTableChange(documentAlerts.TABLE, 'update', invoiceId);
        } catch (e) {
            console.error('[invoice/_fillInvoice] оповещения не пересчитаны:', e && e.message || e);
        }

        const freshInvoice = await modelsDB.Invoices.findByPk(invoiceId, { raw: true });
        const skippedNotice = await _skippedNotice(allSkipped, ctx.sessionID);
        // Пустой счёт без объяснения читается как поломка. Сказать, что услуги
        // уже выставлены, обязательно: это нормальный исход («второй счёт по той
        // же брони»), и он выглядит в точности как сбой.
        const alreadyNotice = limited.droppedCount
            ? await tfForSession(fromBookingsCount ? 'invoice_partly_invoiced' : 'invoice_all_invoiced',
                ctx.sessionID, { count: limited.droppedCount })
            : null;
        // Строки «Buchungen» — со скидками броней, которые заполнение могло вписать.
        return { invoice: freshInvoice, lines: allLines, bookings: links, skippedNotice, alreadyNotice };
    }

    /**
     * ОБРАБОТЧИК ПРОВЕДЕНИЯ СЧЁТА (`entityConfig.posting.handler = "invoice.postIssue"`).
     *
     * Для счёта «выставлен» = «проведён» (решение ТЗ §5.3), поэтому выставление
     * стало обработчиком проведения, а кнопка «Выставить» — ядровой командой
     * `post`. Что изменилось и что нет:
     *
     *   - состояние `issued` ставит ЯДРО (`posting.statusOnPost`), а не этот код:
     *     иначе смена состояния и снятие архивной копии были бы двумя разными
     *     решениями и однажды разошлись бы;
     *   - проверка полноты реквизитов § 14 UStG БРОСАЕТ исключение — и это нужно:
     *     документ уходит в состояние «ошибка проведения» с текстом причины, а
     *     неполный счёт выставленным не становится;
     *   - архивная копия ложится В ТОЙ ЖЕ ТРАНЗАКЦИИ. Прежде статус писался
     *     отдельно, и сорвавшаяся запись копии оставляла выставленный счёт без
     *     архива: печатать пришлось бы живой сборкой, а она со временем разойдётся
     *     с документом, который клиент получил на руки (§ 14b UStG, 8 лет);
     *   - распроведения нет (`posting.unpost: []`): выставленный счёт исправляется
     *     только встречным документом (GoBD);
     *   - повторное проведение второй копии в архив НЕ кладёт: копия — снимок
     *     МОМЕНТА выставления, а не текущего состояния.
     *
     * Сигнатура — `(doc, ctx)`, как у любого обработчика проведения. Писать
     * обязательно через `ctx.dbGateway`: он несёт транзакцию проведения.
     */
    /**
     * ДОЛГ КЛИЕНТА — движение счёта по регистру взаиморасчётов.
     *
     * Счёт не двигает деньги, но создаёт требование: с этого момента клиент нам
     * должен. Раньше регистр знал только о платежах, поэтому оплата без счёта
     * уводила остаток в минус — половина картины.
     *
     * Сумма — БРУТТО собранного документа, то есть ровно то, что напечатано.
     * Считать её здесь заново значило бы завести второй счёт-калькулятор, который
     * однажды разойдётся с печатной формой.
     *
     * ЗНАК ОТ СУММЫ, а не от вида документа: сторно и коррекция — это тоже счета,
     * и суммы у них отрицательные. Правило «положительное = долг растёт»
     * выдержало бы обычный счёт и молча соврало бы на сторно.
     */
    async function writeInvoiceDebt(doc, ctx, brutto) {
        if (!doc.clientId) return;
        const total = M.round(M.num(brutto));
        if (M.isZero(total)) return;

        await ctx.movements.write('reg_settlements', [{
            sign: total < 0 ? -1 : +1,
            organizationId: doc.organizationId,
            clientId: doc.clientId,
            settlementKind: 'debt',
            amount: Math.abs(total),
            comment: doc.name || null
        }]);
    }

    /**
     * ЗАЧЁТ ПРЕДОПЛАТЫ (16.10.2026).
     *
     * Счёт вычитает предоплату броней («Anzahlung»), но раньше регистр расчётов об
     * этом не знал: долг рос на всё брутто, предоплата брони оставалась нетронутой —
     * и СЛЕДУЮЩИЙ счёт по той же брони вычитал её снова (прогон сценариев Q5: 110 − 100
     * при уже учтённых 100), а в расчётах висели «долг 100» и «предоплата 100» сразу.
     *
     * Теперь проведение счёта ЗАЧИТЫВАЕТ вычтенную предоплату: по каждой брони —
     * `prepayment −` (в пределах её остатка НА МОМЕНТ счёта), и столько же `debt −`
     * клиенту. Остаток предоплаты брони после этого — то, что ещё не зачтено, и
     * следующий счёт берёт только его.
     *
     * Отрицательная предоплата (сторно, коррекция) возвращает зачтённое по тем же
     * броням, что зачёл исходный счёт (`correctsInvoiceId`), — зеркально, не по
     * сегодняшним остаткам.
     */
    async function writePrepaymentApplied(doc, ctx) {
        const applied = M.round(M.num(doc.prepayment));
        if (M.isZero(applied) || !doc.clientId) return;
        const registers = require('../../../node_modules/my-old-space/drive_root/db/registers');
        const rctx = { sessionID: ctx.sessionID, transaction: ctx.transaction };
        const parts = [];   // [{ bookingId, amount }] — модуль зачёта по брони

        if (M.cmp(applied, 0) > 0) {
            const links = await modelsDB.InvoiceBookings.findAll({
                where: { invoiceId: doc.UID }, raw: true,
                transaction: ctx.transaction || undefined
            });
            const ids = [...new Set((links || []).map(l => l.bookingId).filter(Boolean))];
            if (!ids.length) return;
            const rows = await registers.balance({
                register: 'reg_settlements',
                dimensions: { bookingId: ids, settlementKind: 'prepayment' },
                groupBy: ['bookingId'],
                moment: ctx.moment,
                context: rctx
            });
            const byBooking = {};
            for (const r of (rows || [])) if (r && r.bookingId) byBooking[r.bookingId] = M.num(r.amount);
            let rest = applied;
            for (const id of ids) {
                if (M.cmp(rest, 0) <= 0) break;
                const avail = byBooking[id] || 0;
                if (M.cmp(avail, 0) <= 0) continue;
                const take = M.cmp(avail, rest) < 0 ? avail : rest;
                parts.push({ bookingId: id, amount: take });
                rest = M.sub(rest, take);
            }
            // Остаток сверх зарегистрированной предоплаты (вписан от руки — деньги
            // прошли мимо программы) зачитывать НЕ из чего: регистр о нём не знает.
        } else if (doc.correctsInvoiceId) {
            const src = await ctx.dbGateway.execute({
                operation: 'read', table: 'reg_settlements',
                where: { recorderTable: 'invoices', recorderUID: doc.correctsInvoiceId, settlementKind: 'prepayment' },
                options: { raw: true, transaction: ctx.transaction || undefined },
                context: rctx
            }) || [];
            let rest = M.num(applied) * -1;   // сколько вернуть, положительно
            for (const m of src) {
                if (!m.bookingId || M.cmp(rest, 0) <= 0) continue;
                const was = M.num(m.amount);
                const back = M.cmp(was, rest) < 0 ? was : rest;
                parts.push({ bookingId: m.bookingId, amount: M.num(back) * -1 });
                rest = M.sub(rest, back);
            }
        }
        if (!parts.length) return;

        const rowsOut = [];
        let total = 0;
        for (const p of parts) {
            const neg = M.cmp(p.amount, 0) < 0;
            rowsOut.push({
                sign: neg ? +1 : -1,
                organizationId: doc.organizationId,
                clientId: doc.clientId,
                bookingId: p.bookingId,
                settlementKind: 'prepayment',
                amount: Math.abs(M.num(p.amount)),
                comment: doc.name || null
            });
            total = M.add(total, p.amount);
        }
        rowsOut.push({
            sign: M.cmp(total, 0) < 0 ? +1 : -1,
            organizationId: doc.organizationId,
            clientId: doc.clientId,
            settlementKind: 'debt',
            amount: Math.abs(M.num(total)),
            comment: doc.name || null
        });
        await ctx.movements.write('reg_settlements', rowsOut);
    }

    /**
     * ВЫСТАВЛЕНО — движение счёта по регистру услуг по брони (ТЗ §7).
     *
     * Пишется из СВОИХ СТРОК, а не из пересчёта состава: строки к моменту
     * проведения заморожены, печатная форма берётся из архива, и считать здесь
     * заново значило бы завести второй ответ на вопрос «что выставлено».
     *
     * ЗНАК постоянный, `−1`: количество и сумма едут такими, какими лежат в
     * строке. Поэтому сторно и коррекция не требуют ни единой строки особого
     * кода — у них строки уже отрицательные, и `−1 × (−20)` возвращает услуги в
     * «не выставлено» само.
     *
     * Строка БЕЗ брони движения не даёт: ручная строка, дописанная в счёт от
     * руки, никакой бронью не заказывалась — её «выставление» нечему
     * противопоставить, а приписав её брони, механизм получил бы отрицательный
     * остаток и объявил расхождением то, что человек сделал намеренно.
     */
    async function writeServicesIssued(doc, ctx) {
        const lines = await modelsDB.InvoiceLines.findAll({
            where: { invoiceId: doc.UID }, raw: true
        });
        const rows = [];
        for (const ln of (lines || [])) {
            if (!ln.bookingId) continue;
            const quantity = M.num(ln.quantity);
            const amount   = M.num(ln.amount);
            if (M.isZero(quantity) && M.isZero(amount)) continue;
            rows.push(Object.assign({
                sign: -1,
                organizationId: ln.organizationId || doc.organizationId,
                bookingId: ln.bookingId,
                quantity,
                amount,
                unitPrice: M.num(ln.unitPrice),
                label: ln.label || null
            }, bookingServices.positionOf(ln)));
        }
        if (rows.length) await ctx.movements.write(bookingServices.REGISTER, rows);
    }

    async function postIssue(doc, ctx) {
        const invoiceId = doc && doc.UID;
        if (!invoiceId) throw new Error(await tForSession('invoice_not_found', ctx.sessionID));

        // Документ собирается ВСЕГДА, даже у уже выставленного счёта: ядро сняло
        // прежние движения перед вызовом обработчика, и не записать их заново
        // значило бы потерять долг при любом перепроведении — молча и насовсем.
        const built = await buildInvoiceDoc(modelsDB, invoiceId, { draft: false });

        // ОДНОРАЗОВОЕ ВНУТРИ ПОВТОРЯЕМОГО (ТЗ §9.5). Проведение зовут снова каскад,
        // очередь после сбоя, групповое перепроведение и первичное наполнение
        // регистров — движения для того и переписываются. А выставление счёта
        // одноразово, и признак этого — НАЛИЧИЕ АРХИВНОЙ КОПИИ, а не состояние
        // документа: состояние ставит ядро после обработчика, его можно сменить
        // руками админским обходом, а копия либо снята, либо нет. Пересобрать её
        // сегодня — значит собрать по сегодняшним справочникам и ценам и разойтись
        // с бумагой, которая у клиента на руках (§ 14b UStG, хранение 8 лет).
        const archived = await documentArchive.exists('invoices', invoiceId);

        if (!archived) {
            // Полнота реквизитов — условие СОСТОЯНИЯ, а не печати.
            if (built.missingKeys && built.missingKeys.length) {
                const names = [];
                for (const key of built.missingKeys) names.push(await tForSession(key, ctx.sessionID));
                throw new Error(await tForSession('invoice_issue_missing_data', ctx.sessionID)
                    + ' ' + names.join('; '));
            }

            // ПРЕДОПЛАТА НЕ БОЛЬШЕ ИТОГА — условие состояния, как и § 14.
            //
            // Заполнение счёта ограничивает её само (`capPrepayment`), но поле
            // правится руками, и выставить счёт, который возвращает деньги,
            // нельзя: клиенту уходит документ с отрицательной суммой к оплате,
            // а регистр расчётов зачитывает аванса больше, чем счётом начислено
            // (прогон 16.10.2026: счёт на 457,00 с предоплатой 20 050,00 вышел
            // без единого вопроса). Поправить это молча тоже нельзя — число
            // ввёл человек, и менять его за него в денежном поле не дело
            // программы. Поэтому отказ словами, с обоими числами.
            const capped = capPrepayment(doc.prepayment, built.brutto);
            if (M.cmp(capped, M.round(M.num(doc.prepayment))) !== 0) {
                // Суммы — в виде, привычном читателю сообщения (язык СЕССИИ: это
                // сообщение человеку, а не содержимое документа), иначе немец
                // читает «20050.00» и спотыкается о точку.
                const sc = await getSessionContext(ctx.sessionID);
                const lang = (sc && sc.language) || 'de';
                throw new Error(await tfForSession('invoice_prepayment_exceeds_total', ctx.sessionID, {
                    prepayment: locale.money(doc.prepayment, lang),
                    total:      locale.money(built.brutto, lang)
                }));
            }

            // Дата выставления — ДАТА ДОКУМЕНТА, а не показания часов. По
            // § 14 Abs. 4 Nr. 3 UStG Ausstellungsdatum и есть дата счёта, так что
            // это одно и то же значение: сколько его ни ставь повторно, оно не
            // изменится, и вопрос «что делать при перепроведении» исчезает по
            // построению. Заодно чинится ошибка, которая была и без повторов:
            // счёт, выставленный задним числом, получал «сегодня».
            const issuedAt = isEmptyDate(doc.date) ? new Date() : new Date(doc.date);
            await ctx.dbGateway.execute({
                operation: 'update',
                table: 'invoices',
                where: { UID: invoiceId },
                data: { issuedAt },
                context: { sessionID: ctx.sessionID }
            });

            // Снимок кладём уже с итоговым состоянием: архив хранит документ таким,
            // каким он ушёл, а ушёл он выставленным. Состояние в базе к этому моменту
            // ещё `draft` — его поставит ядро после обработчика, — поэтому в payload
            // оно подставляется явно.
            built.payload.invoice = Object.assign({}, built.payload.invoice,
                { status: 'issued', issuedAt });

            await documentArchive.save({
                documentTable:  'invoices',
                documentUID:    invoiceId,
                documentNumber: doc.number || null,
                organizationId: doc.organizationId || null,
                lang:           built.lang || null,
                html:           built.html,
                payload:        built.payload,
                createdBy:      ctx.requestedBy || null,
                transaction:    ctx.transaction
            });
        }

        await writeInvoiceDebt(doc, ctx, built.brutto);
        await writePrepaymentApplied(doc, ctx);
        await writeServicesIssued(doc, ctx);
    }


    return {
        // Обработчик ПРОВЕДЕНИЯ. Зовётся ядром через `entityHooks`, а не как RPC:
        // у него другая сигнатура `(doc, ctx)`. `init.js` снимает его отсюда и
        // регистрирует по имени `invoice.postIssue`.
        postIssue,

        // ── RPC: «Заполнить» — перезаполняет строки счёта из его броней ───
        async fillInvoice({ invoiceId }, ctx) {
            if (!invoiceId) return { error: await tForSession('invoice_not_found', ctx.sessionID) };
            try {
                return await _fillInvoice(invoiceId, ctx);
            } catch (e) {
                return { error: (e && e.message) || String(e) };
            }
        },

        // ── RPC: подготовка НОВОГО счёта из брони (кнопка «Создать счёт») ──
        // НИЧЕГО не пишет в БД: считает строки и возвращает prefill/prefillTabular
        // для открытия ЗАПОЛНЕННОЙ новой формы счёта («создать на основании»).
        // Номер/дата/представление присвоятся при сохранении формы (хуки dbGateway).
        /**
         * РЕКВИЗИТЫ ФОРМЫ счёта: «сумма к оплате».
         *
         * Нижняя строка таблицы — это сумма КОЛОНКИ строк, и скидка с
         * предоплатой в неё не входят: на печати стоит одно число, а на экране
         * другое (прогон 16.10.2026, Q14.4). Поэтому на форме есть отдельный
         * реквизит, и считает его СЕРВЕР — тем же расчётом, которым печатается
         * «Gesamtbetrag» (`reports/invoice/totals.js`).
         */
        async onLoadAttributes({ recordID, isNew, record }, ctx) {
            if (isNew || !recordID) return { payableAmount: 0 };
            const lines = await modelsDB.InvoiceLines.findAll({
                where: { invoiceId: recordID }, raw: true
            });
            const links = await modelsDB.InvoiceBookings.findAll({ where: { invoiceId: recordID }, raw: true });
            const total = await _payableTotal(lines, record || {}, links);
            return { payableAmount: M.num(M.sub(total, M.num((record || {}).prepayment))) };
        },

        /**
         * «Сумма к оплате» по ТОМУ, ЧТО СЕЙЧАС НА ФОРМЕ, — для живого пересчёта.
         *
         * Клиент правит строку и сразу спрашивает число здесь, а не считает его
         * сам: правило скидки знает справочник (`tax_categories.discountable` —
         * курортный сбор уменьшать нельзя), и вторая копия этого правила в
         * браузере разошлась бы с печатью. Метод НИЧЕГО НЕ ПИШЕТ.
         */
        async payable({ lines, discountMode, discountValue, prepayment, bookings }, ctx) {
            const rows = Array.isArray(lines) ? lines : [];
            const total = await _payableTotal(rows, { discountMode, discountValue },
                Array.isArray(bookings) ? bookings : []);
            return { payableAmount: M.num(M.sub(total, M.num(prepayment))) };
        },

        async prepareFromBooking({ bookingId }, ctx) {
            if (!bookingId) return { error: await tForSession('booking_not_found', ctx.sessionID) };
            const booking = await modelsDB.Bookings.findByPk(bookingId, { raw: true });
            if (!booking) return { error: await tForSession('booking_not_found', ctx.sessionID) };

            // НЕПРОВЕДЁННАЯ БРОНЬ — отказ со словами, а не пустой счёт.
            //
            // Состав услуг счёт берёт из остатка регистра, а «заказано» туда
            // пишет проведение брони — всегда отложенное (синхронного нет ни в
            // одном режиме). Пока бронь стоит в очереди, остатка по ней нет, и
            // молча отдать пустой prefill значило бы отдать счёт без услуг,
            // причём выглядело бы это поломкой расчёта. Поэтому спрашиваем
            // состояние и отвечаем человеку: «в очереди» — подождать и повторить,
            // остальное («не проведена», «ошибка проведения») — разбираться с
            // бронью; причина уже лежит в строке очереди и показывается штатно.
            const postState = booking.postingState || 'notPosted';
            if (postState !== 'posted') {
                return { error: await tForSession(
                    postState === 'queued' ? 'booking_posting_pending' : 'booking_not_posted',
                    ctx.sessionID) };
            }

            // ОТМЕНЁННАЯ БРОНЬ СЧЁТА НЕ ПОЛУЧАЕТ (решение владельца 17.10.2026):
            // услуги не оказаны, и движений «заказано» у неё нет. Без этой
            // проверки счёт вышел бы пустым с сообщением «все услуги уже
            // выставлены» — ответ на другой вопрос, то есть ложь. Плата за
            // отмену (Stornogebühr) — отдельный предмет и отдельный документ.
            if (await bookingStatus.isCancelled(booking, ctx)) {
                return { error: await tForSession('booking_cancelled_no_invoice', ctx.sessionID) };
            }

            try {
                const mode = await resolveOrgPricingMode(modelsDB, booking.organizationId);
                // Дата счёта появится только при сохранении — в режиме invoiceDate
                // берём текущий момент (его же поставит хук default.documentDate).
                const pricingDate = (mode === 'invoiceDate')
                    ? new Date()
                    : (booking.date || new Date());
                const { lines, skipped, invLang } = await services.buildLines({ bookingId, pricingDate }, ctx);
                const taxRateRows = await modelsDB.TaxRates.findAll({ raw: true });
                const collapsed = services.collapse(lines, taxRateRows, invLang);

                // Только невыставленное — тем же путём, что «Заполнить»:
                // у счёта, которого ещё нет в базе, собственных движений быть не
                // может, поэтому исключать нечего (`invoiceId` не передаём).
                const limited = await _limitToRemaining(collapsed, {
                    bookingIds: [bookingId], sessionID: ctx.sessionID
                });
                limited.lines.forEach((ln, i) => { ln.sortOrder = i + 1; });

                // Предоплата, которую подставляет ПРОГРАММА, не может быть больше
                // того, что счёт просит заплатить: иначе человек видит в новой
                // форме отрицательную сумму к оплате, а выставление потом
                // откажет. Излишек остаётся остатком предоплаты по брони.
                // Скидка брони — в её строке «Buchungen», на её строки; шапка пуста.
                const bookingRow = {
                    organizationId: booking.organizationId,
                    bookingId,
                    discountMode:  booking.discountMode || 'percent',
                    discountValue: Number(booking.discountValue) || 0
                };
                const prepayCap = await _payableTotal(limited.lines, {}, [bookingRow]);
                const prepayOffered = capPrepayment(
                    await settlementBalance.ofBooking({ bookingId: booking.UID, sessionID: ctx.sessionID }),
                    prepayCap);

                return {
                    skippedNotice: await _skippedNotice(skipped, ctx.sessionID),
                    alreadyNotice: limited.droppedCount
                        ? await tfForSession(limited.lines.length
                            ? 'invoice_partly_invoiced' : 'invoice_all_invoiced',
                            ctx.sessionID, { count: limited.droppedCount })
                        : null,
                    prefill: {
                        organizationId: booking.organizationId,
                        hotelId:        booking.hotelId,
                        clientId:       booking.clientId,
                        status:         'draft',
                        // Остаток регистра расчётов по броне, но не больше суммы
                        // этого счёта (см. выше и `capPrepayment`).
                        prepayment:     prepayOffered,
                        // Скидка шапки — дополнительная на весь счёт: из брони не берётся.
                        discountMode:   'percent',
                        discountValue:  0
                    },
                    prefillTabular: {
                        invoice_bookings: [bookingRow],
                        invoice_lines: limited.lines
                    }
                };
            } catch (e) {
                return { error: (e && e.message) || String(e) };
            }
        },

        // ── RPC: значения по умолчанию для РУЧНОЙ строки счёта ────────────
        // Пользователь выбрал услугу в пустой строке ТЧ «Спецификация» — форма
        // обязана сразу показать цену и ставку, а не оставлять их пустыми
        // (иначе строка молча уходит в счёт нулём). Цена — из среза прайс-листов
        // (только позиция БЕЗ возрастной полосы: у полосной услуги цена зависит
        // от гостя, ручная строка такого контекста не имеет). Ставка — из
        // налоговой группы услуги на дату счёта.
        async getServiceLineDefaults({ invoiceId, serviceId }, ctx) {
            if (!serviceId) return {};
            try {
                const svc = await modelsDB.Services.findByPk(serviceId, { raw: true });
                if (!svc) return {};
                const invoice = invoiceId ? await modelsDB.Invoices.findByPk(invoiceId, { raw: true }) : null;
                const orgId   = (invoice && invoice.organizationId) || svc.organizationId;
                const hotelId = (invoice && invoice.hotelId) || svc.hotelId || null;
                const atDate  = (invoice && invoice.date) ? new Date(invoice.date) : new Date();

                // Комнаты счёта: позиция услуги в прайс-листе опознаётся по связке
                // «услуга + комната + возрастная полоса» (Endreinigung стоит по-разному
                // в разных квартирах). Ручная строка сама комнату не несёт — берём её
                // из броней-оснований счёта, ТОЧНО ТАК ЖЕ, как это делает расчёт
                // (`pricesForRoom`). Брать «первую попавшуюся» позицию нельзя: счёт по
                // FeWo III получал цену уборки FeWo I и молча ошибался на 10 €.
                let invoiceRoomIds = [];
                if (invoiceId) {
                    const links = await modelsDB.InvoiceBookings.findAll({ where: { invoiceId }, raw: true });
                    const bIds = [...new Set(links.map(l => l.bookingId).filter(Boolean))];
                    if (bIds.length) {
                        const brooms = await modelsDB.BookingRooms.findAll({ where: { bookingId: bIds }, raw: true });
                        invoiceRoomIds = [...new Set(brooms.map(r => r.roomId).filter(Boolean))];
                    }
                }

                let unitPrice = null;
                // 'ambiguous' — цена у услуги покомнатная, а комната счёта не одна
                // (или её вообще нет): подставлять что-то наугад запрещено.
                let priceIssue = null;
                if (orgId) {
                    // Ручная строка не привязана к брони — дата ценообразования
                    // для неё это дата самого счёта (режим pricingDateMode
                    // различает бронь и счёт только для строк, идущих ИЗ брони).
                    const slice = await priceResolver.loadSlice({ organizationId: orgId, hotelId, pricingDate: atDate });
                    const bands = priceResolver.pickServicePrices(slice, { serviceId });
                    const flat  = bands.filter(p => !priceResolver.hasAgeBand(p));
                    const roomBands = flat.filter(p => p.roomId != null);
                    if (roomBands.length) {
                        // Услуга тарифицируется покомнатно.
                        const mine = (invoiceRoomIds.length === 1)
                            ? roomBands.filter(p => p.roomId === invoiceRoomIds[0])
                            : [];
                        if (mine.length) unitPrice = Number(mine[0].price);
                        else {
                            const common = flat.filter(p => p.roomId == null);
                            if (common.length) unitPrice = Number(common[0].price);
                            else priceIssue = 'ambiguous';
                        }
                    } else {
                        const common = flat.filter(p => p.roomId == null);
                        if (common.length) unitPrice = Number(common[0].price);
                    }
                }

                // Ставка НДС — ссылкой на справочник, снапшот % пишет onBeforeSave.
                let taxRateId = null, taxRateName = null;
                if (svc.taxCategoryId) {
                    const [catRates, rates] = await Promise.all([
                        modelsDB.TaxCategoryRates.findAll({ raw: true }),
                        modelsDB.TaxRates.findAll({ raw: true })
                    ]);
                    let best = null;
                    for (const r of catRates) {
                        if (r.taxCategoryId !== svc.taxCategoryId) continue;
                        if (!periodCovers(r, atDate)) continue;
                        if (!best || validFromOrder(r) > validFromOrder(best)) best = r;
                    }
                    const rr = best ? rates.find(x => x.UID === best.rateId) : null;
                    if (rr) { taxRateId = rr.UID; taxRateName = rr.name; }
                }

                return {
                    label: svc.name, sectionLabel: svc.name,
                    unitPrice, taxRateId, taxRateName,
                    taxCategoryId: svc.taxCategoryId || null,
                    // Цены нет ни одной подходящей — форма скажет об этом вслух.
                    noPrice: unitPrice == null,
                    priceIssue
                };
            } catch (e) {
                return { error: (e && e.message) || String(e) };
            }
        },

        // ── RPC: список счетов брони (кнопка/вкладка «Счета» в брони) ─────
        async findInvoicesForBooking({ bookingId }, ctx) {
            if (!bookingId) return { invoices: [] };
            const links = await modelsDB.InvoiceBookings.findAll({ where: { bookingId }, raw: true });
            const ids = [...new Set(links.map(l => l.invoiceId).filter(Boolean))];
            if (!ids.length) return { invoices: [] };
            const invoices = await modelsDB.Invoices.findAll({ where: { UID: ids }, raw: true });
            invoices.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
            return {
                invoices: invoices.map(inv => ({
                    UID: inv.UID, number: inv.number, date: inv.date, status: inv.status, name: inv.name
                }))
            };
        },

        // ── Серверное событие формы: вызывается ДО записи в БД ────────────
        // 1. organizationId в запись и строки ТЧ (паттерн booking).
        // 2. Санитизация числовых полей строк ("" → null).
        // 3. Авторитетный пересчёт amount = quantity * unitPrice построчно.
        /**
         * Счёт впервые записан (событие ядра `onAfterSave`).
         *
         * Счёт из «Rechnung erstellen» приходит НЕСОХРАНЁННЫМ, и оповещения расчёта
         * (`invoice.fillWarnings`: услуга без цены и т. п.) ему было не на что
         * записать — они появлялись только после «Ausfüllen». Один и тот же счёт
         * говорил разное в зависимости от кнопки, которой его сделали (прогон
         * 17.10.2026, Q13; решение владельца 19.10.2026 — выровнять). Здесь та же
         * причина считается тем же расчётом, что у «Ausfüllen», и только у нового
         * черновика: у встречного документа строки — не расчёт брони.
         */
        async onAfterSave({ recordId, isNew }, ctx) {
            if (!isNew || !recordId) return;
            const invoice = await modelsDB.Invoices.findByPk(recordId, { raw: true });
            if (!invoice || invoice.status !== 'draft' || invoice.correctionKind) return;
            const links = await modelsDB.InvoiceBookings.findAll({ where: { invoiceId: recordId }, raw: true });
            const bookingIds = [...new Set(links.map(l => l.bookingId).filter(Boolean))];
            if (!bookingIds.length) return;
            const mode = await resolveOrgPricingMode(modelsDB, invoice.organizationId);
            const allSkipped = [];
            for (const bookingId of bookingIds) {
                const booking = await modelsDB.Bookings.findByPk(bookingId, { raw: true });
                if (!booking) continue;
                const pricingDate = (mode === 'invoiceDate')
                    ? (invoice.date || new Date())
                    : (booking.date || invoice.date || new Date());
                const { skipped } = await services.buildLines({ bookingId, pricingDate }, ctx);
                for (const s of (skipped || [])) {
                    if (!allSkipped.some(x => x.service === s.service && x.reason === s.reason)) allSkipped.push(s);
                }
            }
            const documentAlerts = require('../../../node_modules/my-old-space/drive_root/db/documentAlerts');
            await documentAlerts.rebuild({
                table: 'invoices', uid: recordId,
                ruleCodes: ['invoice.fillWarnings'],
                input: { skipped: allSkipped },
                sessionID: ctx.sessionID,
                requestedBy: (ctx.user && ctx.user.UID) || null
            });
        },

        async onBeforeSave({ record, changes, tabularSections, parentUID, isNew, counterOf }, ctx) {
            if (!changes.organizationId) {
                try {
                    const globalCtx = require('../../../node_modules/my-old-space/drive_root/globalServerContext');
                    const user = await globalCtx.getUserBySessionID(ctx.sessionID);
                    if (user && user.organizationId) {
                        changes.organizationId = user.organizationId;
                    }
                } catch (e) {
                    console.warn('[invoice/onBeforeSave] Could not resolve user org:', e && e.message);
                }
            }
            let orgId = changes.organizationId;
            if (!orgId) {
                const invId = parentUID || (changes && changes.UID);
                if (invId) {
                    try {
                        const dbRec = await modelsDB.Invoices.findByPk(invId, { raw: true });
                        if (dbRec) orgId = dbRec.organizationId;
                    } catch (_) {}
                }
            }
            if (orgId) {
                for (const rows of Object.values(tabularSections)) {
                    for (const row of rows) {
                        if (!row.organizationId) row.organizationId = orgId;
                    }
                }
            }

            // Природа встречного документа — не реквизит формы. Вид документа и
            // ссылку на исходный счёт ставит КОМАНДА («Сторнировать» /
            // «Скорректировать»), и только она: сменить их у сохранённого
            // документа значит оторвать его от счёта, который он исправляет, —
            // а с ним и от § 31 Abs. 5 UStDV, который эту связь требует.
            // Поля показываются на форме как сведение, писать их оттуда нельзя.
            delete changes.correctionKind;
            delete changes.correctsInvoiceId;

            // Скидка счёта: пустое/нечисло → 0, отрицательное → 0; режим по умолчанию.
            // КРОМЕ сторно: его абсолютная скидка отрицательна по смыслу (хук
            // invoice.onStorno), и обнуление вернуло бы клиенту больше, чем он
            // заплатил. Вид документа — от ядра (`counterOf` новой записи) или из
            // базы у сохранённой; присланному формой `correctionKind` не верим.
            if ('discountValue' in changes) {
                let kind = counterOf ? counterOf.kind : null;
                if (!kind && !isNew && parentUID) {
                    try {
                        const saved = await modelsDB.Invoices.findByPk(parentUID, { raw: true });
                        kind = saved ? saved.correctionKind : null;
                    } catch (_) {}
                }
                const dv = Number(changes.discountValue);
                changes.discountValue = !Number.isFinite(dv) ? 0
                    : (kind === 'storno' ? dv : Math.max(0, dv));
            }
            if ('discountMode' in changes && !changes.discountMode) changes.discountMode = 'percent';

            // Нормализуются ОБЕ строковые части одинаково: «как должно быть»
            // у коррекции — такие же строки счёта (услуга, ставка, цена), и
            // считать их сумму по другим правилам нельзя — разница поехала бы.
            const lines = [].concat(
                tabularSections.invoice_lines || [],
                tabularSections.invoice_target_lines || []
            );
            if (lines.length) {
                // Справочники для авторитетного заполнения строк: ставка НДС ВСЕГДА
                // из tax_rates (по taxRateId), вручную % нигде не вводится; услуга
                // подставляет имя и (если ставка не выбрана) ставку своей налоговой
                // группы на дату документа счёта.
                const taxRateRows = await modelsDB.TaxRates.findAll({ raw: true });
                const rateById = {};
                for (const r of taxRateRows) rateById[r.UID] = Number(r.rate) || 0;

                const needSvc = [...new Set(lines.filter(l => l && l.serviceId).map(l => l.serviceId))];
                const svcRows = needSvc.length
                    ? await modelsDB.Services.findAll({ where: { UID: needSvc }, raw: true }) : [];
                const svcById = {};
                for (const s of svcRows) svcById[s.UID] = s;

                // Дата документа — для резолва ставки налоговой группы услуги.
                let invDate = changes && changes.date;
                if (!invDate) {
                    const invId2 = parentUID || (changes && changes.UID);
                    if (invId2) {
                        try {
                            const rec2 = await modelsDB.Invoices.findByPk(invId2, { raw: true });
                            if (rec2) invDate = rec2.date;
                        } catch (_) {}
                    }
                }
                const atDate = invDate ? new Date(invDate) : new Date();
                let taxCatRates = null;
                const rateByCategory = async (categoryId) => {
                    if (!categoryId) return null;
                    if (!taxCatRates) taxCatRates = await modelsDB.TaxCategoryRates.findAll({ raw: true });
                    let best = null;
                    for (const r of taxCatRates) {
                        if (r.taxCategoryId !== categoryId) continue;
                        if (!periodCovers(r, atDate)) continue;
                        if (!best || validFromOrder(r) > validFromOrder(best)) best = r;
                    }
                    return best ? (taxRateRows.find(tr => tr.UID === best.rateId) || null) : null;
                };

                const numFields = ['quantity', 'unitPrice', 'taxRate', 'amount', 'sortOrder'];
                for (const row of lines) {
                    for (const f of numFields) {
                        if (row[f] === '') row[f] = null;
                    }
                    if (row.taxRateId === '') row.taxRateId = null;
                    if (row.taxCategoryId === '') row.taxCategoryId = null;

                    // Услуга из справочника: имя строки, а при пустой ставке — ставка
                    // её налоговой группы на дату счёта.
                    const svc = row.serviceId ? svcById[row.serviceId] : null;
                    if (svc) {
                        if (!row.label) row.label = svc.name;
                        if (!row.sectionLabel) row.sectionLabel = svc.name;
                        if (!row.taxCategoryId) row.taxCategoryId = svc.taxCategoryId || null;
                        if (!row.taxRateId) {
                            const rr = await rateByCategory(svc.taxCategoryId);
                            if (rr) row.taxRateId = rr.UID;
                        }
                    }

                    // Ставка НДС — авторитетно из справочника по taxRateId
                    // (снапшот % в taxRate обновляется под выбранную ставку).
                    if (row.taxRateId && rateById[row.taxRateId] != null) {
                        row.taxRate = rateById[row.taxRateId];
                    }

                    // Снапшот налоговой категории действителен, только пока её
                    // ставка на дату счёта совпадает с фактической ставкой строки.
                    // Пользователь вручную сменил ставку → основание («durchlaufender
                    // Posten» и т.п.) к строке больше не относится, снимаем его,
                    // иначе сноска в печати уедет не на ту строку свода.
                    if (row.taxCategoryId) {
                        const catRate = await rateByCategory(row.taxCategoryId);
                        if (!catRate || Number(catRate.rate) !== Number(row.taxRate || 0)) {
                            row.taxCategoryId = null;
                        }
                    }

                    // Авторитетный пересчёт суммы (клиентский onChange — только для отклика).
                    const qty  = Number(row.quantity);
                    const unit = Number(row.unitPrice);
                    if (Number.isFinite(qty) && Number.isFinite(unit)) {
                        row.amount = M.mul(unit, qty);
                    }
                    if (row.quantity  == null) row.quantity  = 0;
                    if (row.unitPrice == null) row.unitPrice = 0;
                    if (row.amount    == null) row.amount    = 0;
                    if (row.taxRate   == null) row.taxRate   = 0;
                    if (row.sortOrder == null) row.sortOrder = 0;
                }
            }

        },

        // ── RPC: «Выставить» — проведение счёта ───────────────────────────
        //
        // Момент неизменности — ЭТА команда, а не печать: счёт считается
        // выставленным, когда покинул сферу выставителя. Печать черновика
        // ничего не фиксирует (и уходит с пометкой «Entwurf»).
        //
        // Порядок шагов важен:
        //   1) собрать печатную форму — заодно проверяются реквизиты § 14 UStG;
        //   2) перевести статус (после этого счёт закрыт для правки);
        //   3) положить снимок в архив.
        // Сборка первой: если реквизитов не хватает, счёт обязан остаться
        // черновиком, который ещё можно дозаполнить.
        // RPC `issueInvoice` больше нет: кнопка «Выставить» — ядровая команда
        // `post`, ставящая счёт в очередь проведения (обработчик — `postIssue`).
        // Клиентский код, зовущий выставление напрямую, обошёл бы и очередь, и
        // замок формы, и проверку § 14 в момент проведения.

    };
};
