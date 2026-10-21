'use strict';

/**
 * bookingServices.js — СОСТАВ УСЛУГ ПО БРОНИ: один расчёт на всю систему.
 *
 * Спрашивают отсюда двое, и об одном и том же:
 *   • проведение брони — «что заказано» (движения регистра `reg_booking_services`);
 *   • счёт — «что выставляем» (строки документа при заполнении).
 * Два расчёта одного и того же разойдутся — вопрос только когда, — и тогда регистр
 * начнёт врать, а понять это будет нечем: остаток не сойдётся, а сравнивать будет
 * не с чем. Поэтому расчёт переехал сюда из `apps/invoice/forms/invoices.server.js`
 * ДО появления второго потребителя, а не «потом объединим» (ТЗ «Учёт услуг по
 * брони», §2, этап 1).
 *
 * ── КЛЮЧ ПОЗИЦИИ — главный инвариант (ТЗ §5) ─────────────────────────────────
 * `POSITION_FIELDS` объявлен ЗДЕСЬ и ровно один раз. Им пользуются:
 *   • измерения регистра `reg_booking_services` (`apps/booking/db/db.json`);
 *   • сопоставление строк коррекции (`entityConfig.correction.difference.matchBy`);
 *   • свёртка строк счёта (ниже).
 * Разойдутся — бронь запишет одну позицию, счёт спишет другую, и остаток не
 * сойдётся НИКОГДА. Совпадение держится не на договорённости, а на построении:
 * обе стороны зовут `collapse`, то есть обе получают позиции одной и той же
 * функцией. Сверку объявления с регистром делает `assertRegisterKey`.
 *
 * ── Что здесь НЕ лежит ───────────────────────────────────────────────────────
 * Тексты для пользователя (предупреждения «услуга не попала в счёт») остаются в
 * приложении счёта: они на языке СЕССИИ, а содержимое документа — на языке
 * ОРГАНИЗАЦИИ, и путать эти два языка нельзя.
 */

const path = require('path');
const FW = path.join(__dirname, '..', '..', '..', 'node_modules', 'my-old-space');

const i18n = require(path.join(FW, 'drive_root', 'i18n'));
// Деньги: суммы хранятся как DECIMAL и приходят из базы СТРОКОЙ, а считаются в
// центах. Любая арифметика над суммами — только через этот модуль.
const M = require(path.join(FW, 'drive_root', 'db', 'money'));
const registers = require(path.join(FW, 'drive_root', 'db', 'registers'));
const { isEmptyDate } = require(path.join(FW, 'drive_root', 'db', 'emptyValues'));
const formulaEngine = require('./formulaEngine');
const { resolveOrgReportLang } = require('./orgReportLanguage');
const { resolveOrgSeasonPriceMode } = require('./orgPricingMode');

/** Таблица регистра «Услуги по брони». */
const REGISTER = 'reg_booking_services';

/**
 * КЛЮЧ ПОЗИЦИИ. Поля, по которым две строки считаются «одной и той же позицией».
 *
 * Вид гостя входит: возрастная группа действительно различает позиции
 * (проверено в данных — `guestTypeId` заполнен у строк гостей с режимом
 * `separate`). Номер и строка доп.услуги входят как ссылки на СВОЮ строку брони:
 * у доп.услуги больше нечем отличить одну от другой, услуги с одной ставкой
 * слились бы в одну позицию, и частично выставленная бронь предложила бы не ту.
 *
 * НАЛОГОВЫЙ КОМПОНЕНТ — ССЫЛКА (`taxComponentId`), а не его имя. Имя — обычные
 * данные, которые владелец правит в справочнике: переименовал «Speisen» в
 * «Essen», и «заказано» уехало бы на новый ключ, а «выставлено» осталось на
 * старом, то есть ту же услугу можно было бы выставить второй раз. Тот же довод,
 * по которому из ключа убрана цена. Имя при этом остаётся в строке счёта
 * снимком для печати (`taxComponentName`): напечатано то, что напечатано.
 *
 * ЦЕНА НЕ ВХОДИТ (решение владельца 01.10.2026). Она различает СТРОКИ ПЕЧАТИ
 * (§ 14 Abs. 4 Nr. 5 UStG: Menge и Einzelpreis — самостоятельные реквизиты,
 * см. `PRINT_SPLIT_FIELDS`), но не позиции учёта. Иначе правка действующего
 * прайс-листа после выставления счёта переводила бы услугу в НОВУЮ позицию: по
 * ней остаток чист, и после следующего сохранения брони ту же услугу можно
 * выставить второй раз — молча, то есть ровно та дыра, из-за которой весь этот
 * учёт и делался. Расхождение в деньгах при этом не теряется: ресурс `amount`
 * покажет разницу при нулевом количестве (§ 17 Abs. 1 UStG).
 */
const POSITION_FIELDS = [
    'serviceId',
    'bookingRoomId',
    'extraLineId',
    'guestTypeId',
    'taxComponentId',
    'taxRate',
    'taxCategoryId'
];

/**
 * Чем свёртка дробит позицию ДОПОЛНИТЕЛЬНО — только ради печати.
 *
 * Объявлено здесь, рядом с ключом позиции, а не «вторым списком» в другом файле:
 * вся разница между учётной позицией и печатной строкой — ровно эта строка кода.
 */
const PRINT_SPLIT_FIELDS = ['unitPrice'];

/** Поля ключа, которые в базе лежат DECIMAL и приходят строкой. */
const DECIMAL_KEY_FIELDS = ['taxRate', 'unitPrice'];

// ── Периоды действия (validFrom..validTo) ────────────────────────────────────
// Пустая граница означает «ограничения нет». Проверять её через `if (r.validTo)`
// НЕЛЬЗЯ: пустая дата в проекте — 0001-01-01, значение истинное, и такая
// проверка объявила бы период истёкшим. Практически это значит, что КАЖДАЯ
// ставка НДС без даты окончания перестала бы применяться, а счета остались бы
// без налога.
const periodCovers = (r, day) =>
    (isEmptyDate(r.validFrom) || new Date(r.validFrom) <= day) &&
    (isEmptyDate(r.validTo)   || new Date(r.validTo)   >= day);

// Для выбора «самой поздней из подходящих» пустое начало — минус бесконечность:
// строка без даты начала действует всегда, но любая строка с датой её перебивает.
const validFromOrder = r => (isEmptyDate(r.validFrom) ? -Infinity : new Date(r.validFrom).getTime());

/**
 * Позиция строки — только поля ключа, приведённые к одному виду.
 *
 * Приведение обязательно: ставка и цена приходят из базы строкой («7.00»), а с
 * формы числом (7), и смешение форм дало бы два разных ключа у одной позиции.
 */
function positionOf(line) {
    const out = {};
    for (const f of POSITION_FIELDS) {
        const v = line ? line[f] : null;
        if (DECIMAL_KEY_FIELDS.indexOf(f) >= 0) out[f] = M.num(v);
        else out[f] = (v === undefined || v === '') ? null : (v === null ? null : String(v));
    }
    return out;
}

/**
 * Строковый ключ позиции — для сопоставления в памяти (Map).
 *
 * Денежные поля нормализуются через `money.db`: «7» и «7.00» обязаны дать ОДИН
 * ключ, иначе остаток регистра не найдёт свою строку счёта.
 */
function keyOf(position, bookingId) {
    const p = (position && position.__isPosition) ? position : positionOf(position);
    const parts = [bookingId == null ? '' : String(bookingId)];
    for (const f of POSITION_FIELDS) {
        parts.push(DECIMAL_KEY_FIELDS.indexOf(f) >= 0 ? M.db(p[f]) : (p[f] == null ? '' : p[f]));
    }
    return parts.join('|');
}

/**
 * Сверка объявления ключа с объявлением регистра.
 *
 * `ctx.movements.write` передаёт поля строки в `create` как есть: измерение, которого
 * в регистре нет, уйдёт в никуда МОЛЧА, и остаток начнёт складывать несравнимые
 * позиции. Поэтому расхождение объявлений — отказ при первом же проведении, а не
 * загадка в отчёте.
 */
function assertRegisterKey() {
    const cfg = registers.get(REGISTER);
    if (!cfg) throw new Error(`[bookingServices] Регистр "${REGISTER}" не объявлен`);
    const missing = POSITION_FIELDS.filter(f => cfg.dimensions.indexOf(f) < 0);
    if (missing.length) {
        throw new Error(`[bookingServices] Регистр "${REGISTER}": ключ позиции объявлен`
            + ` в двух местах по-разному — нет измерений ${missing.join(', ')}`);
    }
    for (const need of ['quantity', 'amount']) {
        if (cfg.resources.indexOf(need) < 0) {
            throw new Error(`[bookingServices] Регистр "${REGISTER}": нет ресурса "${need}"`);
        }
    }
    // Цена обязана быть РЕКВИЗИТОМ, а не измерением: измерением она дробила бы
    // позицию и открывала повторное выставление после правки прайса (см. выше).
    if (cfg.dimensions.indexOf('unitPrice') >= 0) {
        throw new Error(`[bookingServices] Регистр "${REGISTER}": "unitPrice" объявлен`
            + ' измерением — он обязан быть сопроводительным реквизитом');
    }
    return cfg;
}

/**
 * ОСТАТОК «ЧТО ЕЩЁ НЕ ВЫСТАВЛЕНО» по броням, в разрезе позиций.
 *
 * `> 0` — заказано и не выставлено; `< 0` — выставлено больше, чем заказано
 * (гость уехал раньше, бронь урезали после выставления — ТЗ §8).
 *
 * `excludeRecorder` — исключить движения ОДНОГО документа. Нужно заполнению
 * счёта: счёт, который заполняем, свои собственные движения сейчас перепишет, и
 * считать их выставленными значило бы предложить ему пустоту. Случай не
 * умозрительный: объявленный путь исправления выставленного счёта — админ
 * возвращает его в черновик, а ручная смена состояния движений НЕ снимает
 * (`drive_root/db/posting.js` ставит состояние только из самого проведения).
 *
 * @param {object} p — `{ bookingIds, excludeRecorder: {table, uid}, moment, sessionID }`
 * @returns {Promise<Map<string, {quantity:number, amount:number, bookingId:string, position:object}>>}
 */
async function remaining(p) {
    const ids = [...new Set((p && p.bookingIds || []).filter(Boolean))];
    const map = new Map();
    if (!ids.length) return map;

    const rows = await registers.balance({
        register: REGISTER,
        dimensions: { bookingId: ids },
        groupBy: ['bookingId', ...POSITION_FIELDS],
        excludeRecorder: (p.excludeRecorder && p.excludeRecorder.uid) ? p.excludeRecorder : undefined,
        moment: p.moment || undefined,
        // ТРАНЗАКЦИЯ ВЫЗЫВАЮЩЕГО, если он в ней находится. Обязательна для
        // правил оповещений: они считаются ВНУТРИ транзакции проведения, уже
        // после того как обработчик записал движения, и запрос без транзакции не
        // увидел бы их — то есть посчитал бы остаток по старым данным и записал
        // бы оповещение как верное.
        transaction: p.transaction || undefined,
        context: { appName: 'common', sessionID: p.sessionID }
    });

    for (const r of (rows || [])) {
        if (!r) continue;
        const position = positionOf(r);
        position.__isPosition = true;
        const key = keyOf(position, r.bookingId);
        // СКЛАДЫВАЕМ, а не присваиваем. Группировка идёт по значениям столбцов, а
        // ключ — по нормализованным: у строкового измерения NULL и пустая строка
        // в базе различаются, а «пусто» для ключа — одно и то же (правило пустых
        // значений проекта). Две группы, дающие один ключ, — законный случай, и
        // присваивание молча оставило бы от них только последнюю.
        const prev = map.get(key);
        // Количество — тоже DECIMAL и тоже приходит строкой; разбор по
        // десятичной записи здесь нужен ровно за тем же, зачем у сумм.
        const quantity = M.num(r.quantity);
        const amount = M.num(r.amount);
        if (prev) {
            prev.quantity = M.add(prev.quantity, quantity);
            prev.amount = M.add(prev.amount, amount);
            continue;
        }
        map.set(key, { bookingId: r.bookingId, position, quantity, amount });
    }
    return map;
}

/**
 * «ВЫСТАВЛЕНО БОЛЬШЕ, ЧЕМ ЗАКАЗАНО» по одной позиции остатка — сумма расхождения
 * или ноль (ТЗ §8).
 *
 * Признак — отрицательное КОЛИЧЕСТВО, а не отрицательная сумма, и это
 * принципиально. Сумма уходит в минус и от законного действия: пользователь
 * вправе поправить цену в строке счёта (согласованная цена), количество при этом
 * сходится. Пометка, срабатывающая на штатной правке, перестаёт читаться — а
 * перестав читаться, пропускает тот самый случай, ради которого заведена:
 * гость уехал на день раньше, в счёте 11 ночей, в брони 10.
 *
 * Отдаётся при этом СУММА — она и нужна человеку («нужна корректировка на
 * 67,00 €»), количество ночей ему ничего не говорит о деньгах.
 */
function overInvoicedAmount(row) {
    if (!row || M.cmp(row.quantity, 0) >= 0) return 0;
    const amount = M.sub(0, row.amount);
    return M.cmp(amount, 0) > 0 ? amount : 0;
}

module.exports = function (modelsDB, Utilities) {

    // Цены проживания и услуг — ТОЛЬКО через резолвер прайс-листов.
    const priceResolver = require('./priceResolver')(modelsDB);

    // Округление до цента — из общего модуля денег, а не своё. Прежняя запись
    // `Math.round(v * 100) / 100` ошибалась на границе половины цента
    // (1.005 → 1.00, 8.165 → 8.16): множитель 100 сначала загонял число в
    // двоичную дробь чуть меньше нужной.
    const r2 = M.num;

    /**
     * ПОСТРОЕНИЕ ДЕТАЛЬНЫХ СТРОК ПО ОДНОЙ БРОНИ.
     *
     * Данные брони читаются из БД (шапка + ТЧ rooms/guests/roomServices/extraLines).
     * `pricingDate` — дата ценообразования (дата брони или дата счёта, см.
     * `resolveOrgPricingMode`). Возвращает `{ lines, booking, skipped, invLang }`;
     * строки — БЕЗ `invoiceId` и без сквозного `sortOrder` (их проставляет
     * потребитель).
     */
    async function buildLines({ bookingId, pricingDate }, ctx) {
        const booking = await modelsDB.Bookings.findByPk(bookingId, { raw: true });
        if (!booking) return { lines: [] };

        const orgId   = booking.organizationId;
        const hotelId = booking.hotelId;
        const checkInDate  = new Date(booking.checkIn);
        const checkOutDate = new Date(booking.checkOut);
        const nights       = Math.round((checkOutDate - checkInDate) / 86400000);
        if (!isFinite(nights) || nights <= 0) return { lines: [] };

        const [rooms, guests, roomServices, extraLines] = await Promise.all([
            modelsDB.BookingRooms.findAll({ where: { bookingId }, raw: true }),
            modelsDB.BookingGuests.findAll({ where: { bookingId }, raw: true }),
            modelsDB.BookingRoomServices.findAll({ where: { bookingId }, raw: true }),
            modelsDB.BookingExtraLines.findAll({ where: { bookingId }, raw: true })
        ]);

        // Строки счёта — часть ДОКУМЕНТА организации: тексты (sectionLabel, label)
        // строятся на ЯЗЫКЕ ОРГАНИЗАЦИИ (reportLanguage), НЕ на языке сессии.
        const invLang = await resolveOrgReportLang(modelsDB, orgId);
        const seasonPerNight = (await resolveOrgSeasonPriceMode(modelsDB, orgId)) === 'perNight';
        const tInv  = (key)       => i18n.t(key, invLang);
        const tfInv = (key, vars) => i18n.tf(key, invLang, vars);

        // Счётные существительные — через формы числа (i18n.tf с `count`).
        // «1 Gäste»/«1 гостей» в юридическом документе недопустимо, а одиночное
        // заселение — штатный случай: у каждой квартиры есть цена на 1 человека.
        const nGuests = n => tfInv('guests_count', { count: n });
        const nNights = n => tfInv('nights_count', { count: n });

        // Разложение количества на сомножители («2 Gäste × 3 ÜN») собирает СВЁРТКА:
        // там число гостей суммируется по группе. Знак «×» законен ТОЛЬКО когда оба
        // числа — действительно сомножители графы «Количество».
        //
        // Единица ВТОРОГО сомножителя у услуги. Назвать её ночами можно только по
        // ОБЪЯВЛЕННОМУ правилу услуги (quantityFormula = переменная «ночи») и только
        // если количество действительно посчитано правилом: ручной ввод правило
        // перебивает, и тогда это уже не ночи. Совпадение количества с числом ночей
        // основанием НЕ является — три массажа за три ночи не становятся ночёвками.
        const NIGHTS_TOKEN = (formulaEngine.VARIABLES.find(v => v.id === 'nights') || {}).token;
        const serviceUnitsLabel = (svc, rs, cnt) => {
            const f = ((svc && svc.quantityFormula) || '').trim();
            if (NIGHTS_TOKEN && f === NIGHTS_TOKEN && rs.autoQuantity !== false) return nNights(cnt);
            return String(cnt);
        };

        const guestTypes = await modelsDB.GuestTypes.findAll({ raw: true });
        const gtMap = {};
        for (const gt of guestTypes) gtMap[gt.UID] = gt;

        // Название вида гостя — из СПРАВОЧНИКА, на языке организации. Дублировать
        // его строкой в i18n.json нельзя: там оно застынет («Kinder 6–13»), а
        // границы возраста живут в guest_types и владелец вправе их менять — счёт
        // печатал бы полосу, которой уже нет. findAll идёт мимо dbGateway, поэтому
        // перевод берём явно (middleware здесь не отработает).
        const tmw = require(path.join(FW, 'drive_root', 'translationMiddleware'));
        const gtLookup = (invLang && invLang !== 'en')
            ? await tmw.getTranslationLookup('guest_types', invLang, modelsDB) : null;
        const gtName = gt => (gtLookup && gtLookup.get(gt.UID + '|name')) || gt.name;

        // Режим учёта вида гостя в проживании (реквизит справочника):
        //   included — входит в сетку тарифа номера;
        //   separate — своя цена проживания из прайс-листа;
        //   free     — ОБЪЯВЛЕННОЕ бесплатное проживание (младенцы).
        // Различать `free` и «цену забыли завести» обязательно: без этого
        // предупреждение об отсутствии цены срабатывало бы на каждой броне с
        // младенцем, то есть на штатной настройке, и его перестали бы читать.
        const roomRateMode = gt => (gt && gt.roomRateMode) || 'included';

        // Виды гостей в порядке справочника — им же идут строки счёта.
        const gtOrdered = guestTypes.slice().sort((a, b) =>
            (a.displayOrder != null ? a.displayOrder : 50) - (b.displayOrder != null ? b.displayOrder : 50));

        const roomIds  = rooms.map(r => r.roomId).filter(Boolean);
        const roomRecs = roomIds.length ? await modelsDB.Rooms.findAll({ where: { UID: roomIds }, raw: true }) : [];
        const roomMap  = {};
        for (const r of roomRecs) roomMap[r.UID] = r;

        // Срез прайс-листов на дату ценообразования — один на всю бронь.
        const priceSlice = await priceResolver.loadSlice({
            organizationId: orgId, hotelId, pricingDate
        });

        const serviceIds = [...new Set(roomServices.map(s => s.serviceId).filter(Boolean))];
        const svcRecs    = serviceIds.length
            ? await modelsDB.Services.findAll({ where: { UID: serviceIds }, raw: true }) : [];
        const svcMap = {};
        for (const s of svcRecs) svcMap[s.UID] = s;

        // Актуальные полосы цен услуг («срез последних» по позициям услуги).
        const svcPrices = [];
        for (const sid of serviceIds) {
            svcPrices.push(...priceResolver.pickServicePrices(priceSlice, { serviceId: sid }));
        }

        // Налоговые компоненты услуг (дробление одной услуги на несколько ставок НДС).
        const svcComponents = serviceIds.length
            ? await modelsDB.ServiceTaxComponents.findAll({ where: { serviceId: serviceIds }, raw: true }) : [];
        const compMap = {};
        for (const c of svcComponents) (compMap[c.serviceId] = compMap[c.serviceId] || []).push(c);
        for (const k of Object.keys(compMap)) {
            compMap[k].sort((a, b) => (a.displayOrder != null ? a.displayOrder : 50) - (b.displayOrder != null ? b.displayOrder : 50));
        }

        // Налоговые группы и ставки (ставка — ДАННЫЕ, резолв по дате заезда).
        const taxCats     = await modelsDB.TaxCategories.findAll({ raw: true });
        const taxCatRates = await modelsDB.TaxCategoryRates.findAll({ raw: true });
        const taxRateVals = await modelsDB.TaxRates.findAll({ raw: true });
        const catCodeToId = {};
        for (const c of taxCats) catCodeToId[c.code] = c.UID;
        const rateValById = {};
        // Ставка нормализуется в ЧИСЛО на границе чтения: колонка `tax_rates.rate`
        // — DECIMAL и приходит строкой «7.00», а fallback в `resolveRate` числовой.
        // Смешение форм разошлось бы в ключе позиции: «7.00» и 7 — разные ключи, и
        // одинаковые строки перестали бы схлопываться в одну позицию.
        for (const v of taxRateVals) rateValById[v.UID] = M.num(v.rate);

        // Полосы цен услуги для конкретной комнаты (покомнатные → иначе общие).
        const pricesForRoom = (serviceId, roomId) => {
            const rows = svcPrices.filter(p => p.serviceId === serviceId);
            const roomRows = rows.filter(p => p.roomId === roomId);
            return roomRows.length ? roomRows : rows.filter(p => p.roomId == null);
        };

        // Цена ночи вида гостя вне тарифа номера — вкладка прайс-листа «Preise nach
        // Gästeart» (priceResolver.pickGuestTypePrice, 19.10.2026). Раньше её искали
        // у услуги с UID `srv-child`, зашитым в код: такая услуга была только у
        // одного клиента, и у всех остальных дети 2–5 лет не начислялись никогда.

        const lines = [];
        let sortOrd = 0;

        // Услуги брони, которые НЕ дали ни одной строки счёта. Раньше такие услуги
        // выпадали молча (нет цены в прайсе / услуга начисляется расчётом сама) —
        // деньги пропадали из счёта без единого признака. Список уходит наружу
        // предупреждением.
        //   reason: 'auto'    — начисляется расчётом автоматически, строка не нужна;
        //   reason: 'noprice' — в срезе прайс-листов нет подходящей цены;
        //   reason: 'manual'  — количество введено вручную и РАСХОДИТСЯ с правилом
        //                       услуги: строка в счёт попадает (ручной ввод законно
        //                       перебивает правило), но молчать об этом нельзя.
        // Ноль по правилу услуги сюда НЕ попадает: это штатное состояние, а не
        // потерянные деньги (решение владельца 2026-07-29).
        const skipped = [];
        const addSkipped = (name, reason, vars) => {
            if (!name) return;
            if (skipped.some(s => s.service === name && s.reason === reason)) return;
            skipped.push({ service: name, reason, vars: vars || null });
        };

        // Количество услуги по её собственному правилу (services.quantityFormula)
        // на срок этой брони. null — правила нет либо оно не вычисляется. Тот же
        // движок и тот же реестр переменных, что и в пересчёте брони — второго
        // источника правды нет.
        const formulaVars = formulaEngine.resolveVariables({
            checkIn: booking.checkIn, checkOut: booking.checkOut
        });
        const ruleQuantity = (svc) => {
            const f = ((svc && svc.quantityFormula) || '').trim();
            if (!f) return null;
            let q = null;
            try { q = formulaEngine.evaluate(f, formulaVars); } catch (_) { return null; }
            if (q == null || !isFinite(q)) return null;
            return Math.max(0, Math.round(q));
        };

        // Ставка налоговой группы на дату ЗАЕЗДА (дата оказания услуги).
        function resolveRate(categoryId, fallback) {
            if (!categoryId) return fallback;
            let best = null;
            for (const r of taxCatRates) {
                if (r.taxCategoryId !== categoryId) continue;
                if (!periodCovers(r, checkInDate)) continue;
                if (!best || validFromOrder(r) > validFromOrder(best)) best = r;
            }
            if (!best) return fallback;
            const val = rateValById[best.rateId];
            return (val != null) ? val : fallback;
        }
        const rateByCode = (code, fallback) => resolveRate(catCodeToId[code], fallback);
        const svcRate = svc => resolveRate(svc.taxCategoryId, 0);
        // Налоговая категория пишется в строку СНАПШОТОМ (как и % ставки): из неё
        // печатная форма берёт основание ставки (tax_categories.invoiceNote) —
        // напр. «durchlaufender Posten § 10 Abs. 1 S. 4 UStG» для курсбора. Одна и
        // та же ставка 0% может иметь РАЗНЫЕ основания, поэтому хранить достаточно
        // ставки нельзя.
        // ДЛИТЕЛЬНАЯ СДАЧА (> 6 месяцев по договору, признак брони `longTermLetting`):
        // проживание не «kurzfristige Beherbergung» (§ 4 Nr. 12 Satz 2 UStG), а
        // освобождённая сдача жилья (§ 4 Nr. 12 Satz 1 Buchst. a UStG) — категория
        // `exempt_longterm` (0 %, основание печатается из её `invoiceNote`). Только
        // строки проживания: завтрак и прочие услуги остаются при своих категориях.
        const ACC_CODE = (booking && booking.longTermLetting && catCodeToId['exempt_longterm'])
            ? 'exempt_longterm' : 'accommodation';
        const ACCOMMODATION_CAT = catCodeToId[ACC_CODE] || null;

        // Делит строку услуги на компоненты НДС (percent/amount/remainder),
        // поглощая копеечный дрейф.
        function splitLineByComponents(base, comps) {
            const qty  = base.quantity;
            const unit = base.unitPrice;
            const parts = comps.map(c => ({ c, unitPart: 0 }));
            let assigned = 0, remIdx = -1;
            for (let i = 0; i < parts.length; i++) {
                const c = parts[i].c;
                if (c.splitMode === 'remainder') { remIdx = i; continue; }
                const up = c.splitMode === 'amount'
                    ? M.num(c.splitValue)
                    : M.pct(unit, c.splitValue);
                parts[i].unitPart = up;
                assigned = M.add(assigned, up);
            }
            if (remIdx >= 0) parts[remIdx].unitPart = M.sub(unit, assigned);
            else if (parts.length) {
                const last = parts[parts.length - 1];
                last.unitPart = M.add(last.unitPart, M.sub(unit, assigned));
            }
            const out = [];
            let amtSum = 0;
            for (let i = 0; i < parts.length; i++) {
                const { c, unitPart } = parts[i];
                const amount = M.mul(unitPart, qty);
                out.push(Object.assign({}, base, {
                    UID: Utilities.generateUID('InvoiceLines'),
                    label: (base.label || '') + ' – ' + c.name,
                    // Ссылка — для КЛЮЧА ПОЗИЦИИ, имя — для печати. Имя владелец
                    // правит в справочнике, и ключ на нём держаться не вправе.
                    taxComponentId: c.UID || null,
                    taxComponentName: c.name,
                    // Порядок компонента из справочника (comps уже отсортированы
                    // по displayOrder) — по нему свёртка держит Speisen перед
                    // Getränke, а не раскидывает их по величине суммы.
                    _compOrder: i,
                    unitPrice: unitPart,
                    taxRate: resolveRate(c.taxCategoryId, base.taxRate),
                    taxCategoryId: c.taxCategoryId || base.taxCategoryId || null,
                    amount
                }));
                amtSum = M.add(amtSum, amount);
            }
            const drift = M.sub(base.amount, amtSum);
            if (drift !== 0 && out.length) {
                let mx = 0;
                for (let i = 1; i < out.length; i++) if (M.cmp(out[i].amount, out[mx].amount) > 0) mx = i;
                out[mx].amount = M.add(out[mx].amount, drift);
            }
            return out;
        }

        // Компонент действует, если дата услуги (заезд) попадает в validFrom..validTo.
        const componentApplies = c => periodCovers(c, checkInDate);

        function emitServiceLine(base, serviceId) {
            const all = compMap[serviceId];
            const comps = all ? all.filter(componentApplies) : null;
            if (!comps || comps.length === 0) { lines.push(base); return; }
            for (const ln of splitLineByComponents(base, comps)) lines.push(ln);
        }

        for (const room of rooms) {
            if (!room.UID) continue;
            const rGuests = guests.filter(g => g.bookingRoomId === room.UID);
            const rSvcs   = roomServices.filter(s => s.bookingRoomId === room.UID);
            const rInfo   = roomMap[room.roomId];
            // Подпись — представление номера (`name`, «Ferienwohnung Bergblick»), а не его
            // порядковый номер: гость видел в счёте «Zimmer 9» (прогон 17.10.2026, E2).
            // У Seiler name = number, их строки не меняются.
            const rLabel  = rInfo ? (rInfo.name || rInfo.number) : '?';

            // Гости комнаты — по ВИДАМ из справочника, без корзин с порогами.
            // Раньше здесь стояла лесенка `gt.ageFrom >= 16 / 14 / 6 / 3 / 2`:
            // шесть чисел в коде, повторявших границы, которые владелец правит в
            // guest_types. Заведи он седьмой вид или сдвинь границу — расчёт молча
            // отнёс бы гостя не в ту корзину.
            const cntByGt = new Map();
            for (const g of rGuests) {
                const gt = gtMap[g.guestTypeId];
                if (!gt) continue;
                cntByGt.set(gt.UID, (cntByGt.get(gt.UID) || 0) + (g.count || 1));
            }

            // В сетку тарифа номера входят виды с режимом `included`. Это правило
            // данных, а не кода: у другой организации порог другой.
            let billingGuests = 0;
            for (const gt of gtOrdered) {
                if (roomRateMode(gt) === 'included') billingGuests += (cntByGt.get(gt.UID) || 0);
            }

            // 1. Проживание. Как считать проживание через границу сезонов — настройка
            //    организации `common.seasonPriceMode` (решение владельца 16.10.2026):
            //    'arrival' (по умолчанию) — все ночи по цене дня заезда, как выставляет
            //    реальный клиент; 'perNight' — каждая ночь по цене своего сезона
            //    (2 ночи Nebensaison по 110 + 1 ночь Hochsaison по 150 = 370).
            //    Подряд идущие ночи с одной ценой — одна строка; смена цены — новая
            //    строка (§ 14 Abs. 4 Nr. 5: Menge и Einzelpreis каждой позиции верны).
            //    Ночь без цены не теряется молча.
            const nightRuns = [];   // [{ price, nights }]
            let nightsWithoutPrice = 0;
            for (let i = 0; i < nights; i++) {
                const day = new Date(checkInDate.getTime());
                if (seasonPerNight) day.setDate(day.getDate() + i);
                const rpN = priceResolver.pickRoomPrice(priceSlice, {
                    roomId: room.roomId, guestsCount: billingGuests, stayDate: day
                });
                if (!rpN) { nightsWithoutPrice++; continue; }
                const last = nightRuns[nightRuns.length - 1];
                if (last && M.cmp(last.price, rpN.price) === 0) last.nights++;
                else nightRuns.push({ price: rpN.price, nights: 1 });
            }
            for (const run of nightRuns) {
                lines.push({
                    UID: Utilities.generateUID('InvoiceLines'),
                    bookingId, bookingRoomId: room.UID, organizationId: orgId,
                    sectionLabel: tInv('accommodation_section'),
                    // Количество этой строки — НОЧИ, поэтому в подписи их нет: они и
                    // так стоят в графе «Количество». Число гостей, наоборот, есть
                    // только здесь — от него зависит цена, а сомножителем количества
                    // оно не является (цена уже за квартиру целиком).
                    label:    tfInv('room_line_label', { room: rLabel, guests: nGuests(billingGuests) }),
                    quantity: run.nights, unitPrice: run.price,
                    taxRate:  rateByCode(ACC_CODE, 0),
                    taxCategoryId: ACCOMMODATION_CAT,
                    amount:   M.mul(run.price, run.nights), sortOrder: ++sortOrd
                });
            }
            if (nightsWithoutPrice > 0 && billingGuests > 0) {
                // Проживание молча выпадало из счёта, если в срезе прайс-листов нет
                // цены на такое число гостей (новый вид гостя сдвинул счёт, сезон не
                // покрыт, квартиру не внесли в прайс). Это самая дорогая строка
                // документа — молчать о её отсутствии нельзя.
                addSkipped(rLabel, 'roomnoprice', { guests: billingGuests });
            }

            // 2. Виды гостей ВНЕ тарифа номера, у которых есть собственная цена
            //    проживания (вкладка прайс-листа «Preise nach Gästeart»). Цена берётся
            //    по ночам по тому же правилу, что цена номера (`seasonPriceMode`):
            //    смена цены — новая строка.
            for (const gt of gtOrdered) {
                const mode = roomRateMode(gt);
                // `included` уже посчитан в тарифе номера, `free` — объявленное
                // бесплатное проживание. Предупреждать надо только про `separate`:
                // у него ЗАЯВЛЕНА своя цена, а её нет.
                if (mode !== 'separate') continue;
                const n = cntByGt.get(gt.UID) || 0;
                if (n <= 0) continue;
                const gtRuns = [];   // [{ price, nights }]
                let gtNightsWithoutPrice = 0;
                for (let i = 0; i < nights; i++) {
                    const day = new Date(checkInDate.getTime());
                    if (seasonPerNight) day.setDate(day.getDate() + i);
                    const gp = priceResolver.pickGuestTypePrice(priceSlice, {
                        guestTypeId: gt.UID, roomId: room.roomId, stayDate: day
                    });
                    if (!gp || !Number(gp.price)) { gtNightsWithoutPrice++; continue; }
                    const last = gtRuns[gtRuns.length - 1];
                    if (last && M.cmp(last.price, gp.price) === 0) last.nights++;
                    else gtRuns.push({ price: gp.price, nights: 1 });
                }
                // Хоть одна ночь без цены — сказать: заявленная цена не найдена.
                if (gtNightsWithoutPrice > 0) addSkipped(gtName(gt), 'guestnoprice');
                for (const run of gtRuns) {
                    const qty = n * run.nights;
                    lines.push({
                        UID: Utilities.generateUID('InvoiceLines'),
                        bookingId, bookingRoomId: room.UID, organizationId: orgId,
                        guestTypeId: gt.UID,
                        sectionLabel: tInv('accommodation_section'),
                        // Здесь количество — человеко-ночи, и оба сомножителя известны
                        // по построению, поэтому подпись их называет.
                        label:    tfInv('room_guest_type_line_label', {
                            room: rLabel, guestType: gtName(gt),
                            guests: nGuests(n), nights: nNights(run.nights)
                        }),
                        quantity: qty, unitPrice: run.price, taxRate: rateByCode(ACC_CODE, 0),
                        taxCategoryId: ACCOMMODATION_CAT,
                        amount:   M.mul(run.price, qty), sortOrder: ++sortOrd
                    });
                }
            }

            // 3. Услуги из BookingRoomServices (только «включённые», count > 0).
            for (const rs of rSvcs) {
                if (rs.included === false) continue;
                const svc = svcMap[rs.serviceId];
                if (!svc) continue;
                const cnt = Number(rs.count);

                // Сверка количества с правилом услуги. Ручной ввод (autoQuantity=false)
                // правило перебивает — это законно, но пользователь обязан узнать, что
                // счёт расходится с прайс-листом: счёт 00010 получил 120 € уборки,
                // которую правило «только при проживании ≤ 3 ночей» начислять
                // запрещает, и ни один из двух проверяющих этого не заметил.
                const ruleQty = ruleQuantity(svc);
                if (ruleQty != null && rs.autoQuantity === false && ruleQty !== cnt) {
                    addSkipped(svc.name, 'manual', { count: cnt, expected: ruleQty });
                }
                if (!cnt) {
                    // Ноль по правилу услуги — ШТАТНОЕ состояние, а не потерянные
                    // деньги: условие услуги просто не выполнилось (уборка при
                    // проживании > 3 ночей). Решение владельца 2026-07-29: об этом
                    // не сообщать. Предупреждаем только о РАСХОЖДЕНИИ ручного ввода
                    // с правилом (см. выше).
                    continue;
                }

                const linesBefore = lines.length;
                const roomPriceRows = pricesForRoom(rs.serviceId, room.roomId);
                // Полоса есть, если заполнена хотя бы одна граница. Прямое
                // `ageFrom != null` здесь было бы неверно: по правилу умолчаний
                // «пусто» у числа — это 0, а не NULL (см. priceResolver).
                const agePrices = roomPriceRows.filter(sp => priceResolver.hasAgeBand(sp));

                // КАК СЧИТАЕТСЯ УСЛУГА — признак самой услуги, а не догадка по
                // прайс-листу (16.10.2026). Раньше «на гостя» включалось наличием
                // возрастных цен: прогон дал собаке цены по возрастам, и она
                // посчиталась на каждого гостя (15 × 8 вместо 3 × 8). Теперь:
                //   perGuest   — гости × количество; цена по возрастной полосе
                //                гостя, а без полос — одна цена на всех;
                //   perBooking — количество как есть, цена БЕЗ возрастной полосы;
                //                если есть только возрастные — цены нет (и об этом
                //                скажет предупреждение ниже).
                const perGuest = svc.chargeMode === 'perGuest';
                if (perGuest) {
                    const flat = roomPriceRows.find(p => !priceResolver.hasAgeBand(p));
                    // Перебор — по справочнику видов гостей, а не по списку UID в
                    // коде: раньше шесть предопределённых видов были выписаны здесь
                    // поимённо, и седьмой просто не попал бы в счёт.
                    for (const gt of gtOrdered) {
                        const n = cntByGt.get(gt.UID) || 0;
                        if (n <= 0) continue;
                        const sp = agePrices.length > 0
                            ? agePrices.find(p => priceResolver.ageBandMatches(p, gt.ageFrom, gt.ageTo))
                            : flat;
                        if (!sp || sp.price === 0) continue;
                        const qty = n * cnt;
                        const gLabel = gtName(gt);
                        const unitsLabel = serviceUnitsLabel(svc, rs, cnt);
                        emitServiceLine({
                            UID: Utilities.generateUID('InvoiceLines'),
                            bookingId, bookingRoomId: room.UID, organizationId: orgId,
                            serviceId: rs.serviceId, guestTypeId: gt.UID,
                            sectionLabel: svc.name,
                            // Печатную подпись строки услуги собирает СВЁРТКА (из
                            // sectionLabel + видов гостя + компонента + разложения),
                            // поэтому здесь label — только запасное значение на
                            // случай пустого sectionLabel.
                            label:    svc.name,
                            // Составляющие подписи уходят свёртке ОТДЕЛЬНЫМИ
                            // реквизитами, чтобы ей не пришлось разбирать готовый
                            // текст обратно на части. Порядок — из справочника
                            // (guest_types.displayOrder), а не из порядка перебора.
                            _ageLabel: gLabel,
                            _ageOrder: gt.displayOrder != null ? gt.displayOrder : 50,
                            // Сомножители количества — свёртке: печатную подпись
                            // строит она, и число гостей у неё СУММИРУЕТСЯ по группе
                            // (одна ценовая полоса накрывает несколько видов гостей).
                            _persons: n, _unitsLabel: unitsLabel,
                            quantity: qty, unitPrice: sp.price, taxRate: svcRate(svc),
                            taxCategoryId: svc.taxCategoryId || null,
                            amount:   M.mul(sp.price, qty), sortOrder: ++sortOrd
                        }, rs.serviceId);
                    }
                } else {
                    const sp    = roomPriceRows.find(p => !priceResolver.hasAgeBand(p));
                    const price = sp ? sp.price : 0;
                    if (price > 0) {
                        const qty = cnt;
                        emitServiceLine({
                            UID: Utilities.generateUID('InvoiceLines'),
                            bookingId, bookingRoomId: room.UID, organizationId: orgId,
                            serviceId: rs.serviceId, sectionLabel: svc.name,
                            // Как и выше: подпись собирает свёртка, здесь — запасное.
                            label:    svc.name,
                            quantity: qty, unitPrice: price, taxRate: svcRate(svc),
                            taxCategoryId: svc.taxCategoryId || null,
                            amount:   M.mul(price, qty), sortOrder: ++sortOrd
                        }, rs.serviceId);
                    }
                }

                // Услуга включена и количество задано, а строк не появилось — значит
                // в срезе прайс-листов на дату расчёта нет подходящей цены (нет
                // позиции вообще, либо возрастные полосы не накрывают гостей).
                // Молчать здесь нельзя: это недобор денег в счёте.
                // Исключение — услуга «на гостя» в номере БЕЗ гостей: начислять некому,
                // и это не недобор (репетиция обновления 20.10.2026, бронь 1423: второй
                // номер без гостей давал ложное «Kurbeitrag — нет цены»).
                const nobodyToCharge = perGuest && !Array.from(cntByGt.values()).some(n => n > 0);
                if (lines.length === linesBefore && !nobodyToCharge) addSkipped(svc.name, 'noprice');
            }
        }

        // 4. Доп.услуги (booking_extra_lines) — прямо в счёт отдельными строками.
        for (const el of (extraLines || [])) {
            if (!el || !el.name) continue;
            const amount = Number(el.amount);
            if (!Number.isFinite(amount) || amount === 0) continue;
            const rate = el.taxRateId && rateValById[el.taxRateId] != null ? rateValById[el.taxRateId] : 0;
            lines.push({
                UID: Utilities.generateUID('InvoiceLines'),
                bookingId, organizationId: orgId,
                // Ссылка на СВОЮ строку брони — единственное, чем одна доп.услуга
                // отличается от другой: имя пользователь правит, сумма и ставка
                // совпадают запросто. Без неё две доп.услуги с одной ставкой стали
                // бы одной позицией регистра, и частично выставленная бронь
                // предложила бы не ту строку — с чужой суммой.
                extraLineId: el.UID || null,
                sectionLabel: tInv('extra_lines_section'),
                label:    el.name,
                quantity: 1, unitPrice: M.num(amount),
                taxRate:  rate,
                amount:   M.num(amount), sortOrder: ++sortOrd,
                _isExtra: true
            });
        }

        // Приоритет сортировки из displayOrder справочников.
        for (const ln of lines) {
            if (ln._isExtra) {
                ln._sortPriority = 95;
            } else if (ln.serviceId != null) {
                const svc = svcMap[ln.serviceId];
                ln._sortPriority = (svc && svc.displayOrder != null) ? svc.displayOrder : 50;
                // Те же ключи нужны свёртке: она пересобирает строки заново и без
                // них теряет порядок справочника услуг.
                ln._svcOrder = ln._sortPriority;
                ln._svcName  = (svc && svc.name) || '';
            } else if (ln.guestTypeId != null) {
                const gt = gtMap[ln.guestTypeId];
                ln._sortPriority = (gt && gt.displayOrder != null) ? gt.displayOrder : 50;
            } else {
                ln._sortPriority = 10; // проживание — всегда первым
            }
        }
        lines.sort((a, b) => {
            if (a._sortPriority !== b._sortPriority) return a._sortPriority - b._sortPriority;
            return (a.label || '').localeCompare(b.label || '', 'de');
        });
        lines.forEach((ln, i) => {
            ln.sortOrder = i + 1;
            delete ln._sortPriority;
            delete ln._isExtra;
        });
        // invLang уходит наружу: печатную подпись строк услуг собирает свёртка, и
        // язык организации нужен ей так же, как расчёту.
        return { lines, booking, skipped, invLang };
    }

    /**
     * СВЁРТКА детальных строк в «печатный» вид (WYSIWYG).
     *
     * ТЧ счёта хранит РОВНО те строки, что печатаются, — корректировать удобно.
     * Услуги группируются по serviceId + налоговый компонент + ставка + категория
     * + ЦЕНА ЗА ЕДИНИЦУ, проживание и доп.строки — как есть.
     *
     * Цена в ключе — обязательна. Без неё возрастные полосы одной услуги (курсбор
     * 2,10 взр. / 1,00 дети 6–15; завтрак 14,50 / 8,50 / 3,50) сливались в одну
     * строку, и, поскольку общей цены за единицу у них нет, строка вырождалась в
     * «Menge 1 × вся сумма»: в счёте 1397 курсбор печатался как 1 × 72,00 вместо
     * 20 × 2,10 + 20 × 1,00 + 10 × 1,00. Это прямо нарушало § 14 Abs. 4 Nr. 5
     * UStG (Menge и Einzelpreis — самостоятельные реквизиты) и не давало гостю
     * проверить сумму.
     *
     * ЭТУ ЖЕ ФУНКЦИЮ зовёт проведение брони: позиции регистра — её результат, а не
     * похожий расчёт рядом. Поэтому ключ позиции у «заказано» и у «выставлено»
     * совпадает по построению, а не по договорённости (ТЗ §5).
     */
    function collapse(rawLines, taxRateRows, invLang) {
        // Подпись печатной строки услуги собирается ЗДЕСЬ, поэтому язык организации
        // нужен и здесь: строки счёта — содержимое документа организации, а не
        // интерфейс пользователя.
        const tfL = (key, vars) => i18n.tf(key, invLang || 'en', vars);
        const accommodation = [];
        const extra = [];
        const svcGroups = new Map(); // ключ: serviceId|компонент|ставка|категория|цена
        for (const ln of rawLines) {
            if (ln.serviceId) {
                const comp = ln.taxComponentName || '';
                // Ключ печатной строки = ключ позиции БЕЗ номера и вида гостя
                // (услуга в двух квартирах и две возрастные группы с одной ценой
                // печатаются одной строкой) ПЛЮС цена (§ 14 Abs. 4 Nr. 5).
                // Собирается из объявления, а не выписан здесь руками: иначе это
                // был бы второй список, который однажды разойдётся с первым.
                const key = PRINT_SPLIT_FIELDS
                    .concat(POSITION_FIELDS.filter(f => f !== 'bookingRoomId' && f !== 'guestTypeId' && f !== 'extraLineId'))
                    .map(f => (DECIMAL_KEY_FIELDS.indexOf(f) >= 0 ? M.db(ln[f]) : (ln[f] == null ? '' : String(ln[f]))))
                    .join('|');
                let g = svcGroups.get(key);
                if (!g) {
                    g = { proto: ln, base: ln.sectionLabel || ln.label, comp,
                          ages: [], ageOrder: Infinity, rows: [],
                          persons: 0, unitsLabel: null, unitsMixed: false };
                    svcGroups.set(key, g);
                }
                if (ln._persons != null) {
                    g.persons += Number(ln._persons) || 0;
                    // Разные вторые сомножители в одной группе (напр. одна услуга с
                    // разным количеством по номерам) разложить нечем — тогда его
                    // просто не печатаем, вместо того чтобы взять первый попавшийся.
                    if (g.unitsLabel == null) g.unitsLabel = ln._unitsLabel;
                    else if (g.unitsLabel !== ln._unitsLabel) g.unitsMixed = true;
                }
                if (ln._ageLabel) {
                    const ord = ln._ageOrder != null ? ln._ageOrder : 50;
                    if (!g.ages.some(a => a.label === ln._ageLabel)) g.ages.push({ label: ln._ageLabel, order: ord });
                    if (ord < g.ageOrder) g.ageOrder = ord;
                }
                g.rows.push(ln);
            } else if (ln.bookingRoomId) {
                accommodation.push(ln);
            } else {
                extra.push(ln);
            }
        }
        const services = [];
        for (const g of svcGroups.values()) {
            const amount = M.sum(g.rows, 'amount');
            const qtySum = r2(g.rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0));
            // Цена входит в ключ группы, поэтому она одна на все строки —
            // количество всегда суммируется, вырожденного «1 × вся сумма» нет.
            // Вид гостя — перед налоговым компонентом: строки одного гостя должны
            // читаться подряд («… — Erwachsener – Speisen», «… — Erwachsener –
            // Getränke»), а не разбиваться по еде и напиткам.
            let label = g.base;
            if (g.ages.length) {
                label += ' — ' + g.ages.slice()
                    .sort((a, b) => a.order - b.order).map(a => a.label).join(', ');
            }
            if (g.comp) label += ' – ' + g.comp;
            // Разложение количества — в конце: «Kurbeitrag — Erwachsener (2 Gäste ×
            // 3 ÜN)». Без него графа «Количество» показывала бы 6 без единого
            // объяснения, откуда шестёрка.
            if (g.persons > 0 && g.unitsLabel && !g.unitsMixed) {
                label += ' (' + tfL('line_qty_breakdown', {
                    guests: tfL('guests_count', { count: g.persons }),
                    units:  g.unitsLabel
                }) + ')';
            }
            // ВИД ГОСТЯ сохраняется, если он у всех строк группы ОДИН И ТОТ ЖЕ.
            //
            // Прежнее условие — `g.rows.length === 1` — привязывало обнуление к
            // ЧИСЛУ строк, а не к их различию: одна и та же бронь с одним номером
            // вид гостя сохраняла, а с двумя теряла, хотя гость там тот же.
            // Значение входит в ключ позиции регистра, и зависеть от числа номеров
            // оно не вправе. Печатная подпись от этого не меняется: она собрана
            // выше из `g.ages`, где перечислены все виды группы.
            const gtIds = new Set(g.rows.map(r => r.guestTypeId || null));
            services.push({
                UID: Utilities.generateUID('InvoiceLines'),
                bookingId:        g.proto.bookingId,
                organizationId:   g.proto.organizationId,
                serviceId:        g.proto.serviceId,
                // НОМЕР у свёрнутой строки услуги ПУСТ — и это объявлено, а не
                // «забыли скопировать»: услуга, оказанная в двух квартирах по одной
                // цене, печатается одной строкой, значит и позиция у неё одна.
                // Проведение брони зовёт эту же функцию, поэтому «заказано» теряет
                // номер ровно там же, где «выставлено».
                bookingRoomId:    null,
                // Доп.строкой услуга не бывает: у неё есть serviceId.
                extraLineId:      null,
                guestTypeId:      gtIds.size === 1 ? (g.proto.guestTypeId || null) : null,
                taxComponentId:   g.proto.taxComponentId || null,
                taxComponentName: g.proto.taxComponentName || null,
                sectionLabel:     g.proto.sectionLabel || null,
                label:            label,
                quantity:         qtySum,
                unitPrice:        Number(g.proto.unitPrice) || 0,
                taxRate:          g.proto.taxRate || 0,
                taxCategoryId:    g.proto.taxCategoryId || null,
                amount,
                // Ключи порядка — временные, снимаются сразу после сортировки.
                _svcOrder:  g.proto._svcOrder != null ? g.proto._svcOrder : 50,
                _svcName:   g.proto._svcName || '',
                _ageOrder:  g.ageOrder === Infinity ? 0 : g.ageOrder,
                _compOrder: g.proto._compOrder != null ? g.proto._compOrder : 0
            });
        }
        accommodation.sort((a, b) => b.amount - a.amount);
        // Строки одной услуги обязаны идти подряд. Сортировка по одной лишь сумме
        // их перемешивала: в счёте 1396 курсбор вставал между «Frühstück – Speisen»
        // и «Frühstück – Getränke», потому что его 33,60 попадали между ними по
        // величине. Порядок: услуга (displayOrder справочника, при равенстве — по
        // названию) → вид гостя (displayOrder) → налоговый компонент → сумма.
        // Вид гостя ВЫШЕ компонента: гость сверяет счёт по людям, а не по ставкам.
        services.sort((a, b) => {
            if (a._svcOrder !== b._svcOrder)   return a._svcOrder - b._svcOrder;
            if (a._svcName !== b._svcName)     return a._svcName.localeCompare(b._svcName, 'de');
            if (a._ageOrder !== b._ageOrder)   return a._ageOrder - b._ageOrder;
            if (a._compOrder !== b._compOrder) return a._compOrder - b._compOrder;
            return b.amount - a.amount;
        });
        for (const s of services) {
            delete s._svcOrder; delete s._svcName; delete s._ageOrder; delete s._compOrder;
        }
        const out = accommodation.concat(services, extra);
        // Ссылка на справочник ставок + display-значения для FK-ячеек формы.
        for (const ln of out) {
            const rr = (taxRateRows || []).find(r => Number(r.rate) === Number(ln.taxRate || 0));
            ln.taxRateId = rr ? rr.UID : null;
            if (rr) ln.__taxRateId_display = rr.name;
            if (ln.serviceId && ln.sectionLabel) ln.__serviceId_display = ln.sectionLabel;
        }
        return out;
    }

    /**
     * Позиции брони «как заказано»: свёрнутые строки одной брони.
     *
     * Ровно то, что пишет в регистр проведение брони, и ровно то, из чего счёт
     * берёт свои строки. Отдельная функция существует только затем, чтобы оба
     * потребителя не могли случайно позвать `buildLines` без `collapse`.
     */
    async function orderedPositions({ bookingId, pricingDate }, ctx) {
        const built = await buildLines({ bookingId, pricingDate }, ctx);
        if (!built.lines || !built.lines.length) {
            return { positions: [], booking: built.booking || null, skipped: built.skipped || [] };
        }
        const taxRateRows = await modelsDB.TaxRates.findAll({ raw: true });
        return {
            positions: collapse(built.lines, taxRateRows, built.invLang),
            booking: built.booking,
            skipped: built.skipped || [],
            invLang: built.invLang
        };
    }

    return { buildLines, collapse, orderedPositions };
};

// Объявления уровня модуля — одни на всю систему.
module.exports.REGISTER = REGISTER;
module.exports.POSITION_FIELDS = POSITION_FIELDS;
module.exports.positionOf = positionOf;
module.exports.keyOf = keyOf;
module.exports.assertRegisterKey = assertRegisterKey;
module.exports.remaining = remaining;
module.exports.overInvoicedAmount = overInvoicedAmount;
module.exports.periodCovers = periodCovers;
module.exports.validFromOrder = validFromOrder;
