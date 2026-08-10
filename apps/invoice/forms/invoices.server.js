'use strict';

// Серверные функции формы «Счёт» (документ invoices).
//
// Экспортирует фабрику: module.exports = function(modelsDB, Utilities) { return { ... }; }
// Вызывается из init.js: loadServerScript('invoice.actions', require('./invoices.server')(modelsDB, Utilities), 'user')
//
// Каждая функция получает (params, ctx) где ctx = { sessionID, user, role }.
//
// Расчёт строк (_buildInvoiceLines) переехал сюда из apps/booking/forms/bookings.server.js:
// счёт — самостоятельный документ, строит свои строки сам (кнопка «Заполнить» /
// создание из брони), сохранение брони счета больше НЕ трогает. Данные брони
// (шапка + ТЧ) читаются из БД по bookingId, цены — только через priceResolver
// (срез прайс-листов на дату ценообразования). Ставки НДС по-прежнему резолвятся
// по дате ОКАЗАНИЯ услуги (дата заезда брони) — периодичность касается только цен.

const i18n = require('../../../node_modules/my-old-space/drive_root/i18n');
const formulaEngine = require('../../common/lib/formulaEngine');
const { tForSession, tfForSession } = require('../../../node_modules/my-old-space/drive_forms/globalServerContext');
const { resolveOrgReportLang } = require('../../organizationSettings/lib/orgReportLanguage');
const { resolveOrgPricingMode } = require('../../organizationSettings/lib/orgPricingMode');
const dbGateway = require('../../../node_modules/my-old-space/drive_root/dbGateway');
// Пустая дата — это 0001-01-01, а не NULL (правило проекта, см.
// drive_root/db/emptyValues.js). Проверять заполненность даты через
// `if (r.validTo)` НЕЛЬЗЯ: 0001-01-01 — истинное значение, и такая
// проверка объявит период действия истёкшим.
const { isEmptyDate } = require('../../../node_modules/my-old-space/drive_root/db/emptyValues');

// ── Периоды действия (validFrom..validTo) ────────────────────────────
// Пустая граница означает «ограничения нет». Проверять её через
// `if (r.validTo)` НЕЛЬЗЯ: пустая дата в проекте — 0001-01-01, значение
// истинное, и такая проверка объявила бы период истёкшим. Практически это
// значит, что КАЖДАЯ ставка НДС без даты окончания перестала бы
// применяться, а счета остались бы без налога.
const periodCovers = (r, day) =>
    (isEmptyDate(r.validFrom) || new Date(r.validFrom) <= day) &&
    (isEmptyDate(r.validTo)   || new Date(r.validTo)   >= day);

// Для выбора «самой поздней из подходящих» пустое начало — минус
// бесконечность: строка без даты начала действует всегда, но любая строка
// с датой её перебивает.
const validFromOrder = r => (isEmptyDate(r.validFrom) ? -Infinity : new Date(r.validFrom).getTime());

module.exports = function (modelsDB, Utilities) {

    // Цены проживания и услуг — ТОЛЬКО через резолвер прайс-листов.
    const priceResolver = require('../../common/lib/priceResolver')(modelsDB);

    const r2 = v => Math.round(v * 100) / 100;

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

    // ── Агрегация скидок броней-оснований в одну скидку счёта ─────────────
    // list: [{ mode:'percent'|'amount', value>0 }] по броням с ненулевой скидкой.
    //   все amount → сумма; все percent → max; смешанные → max percent (абсолютные
    //   игнорируем, о чём предупреждаем). warn=true, если ненулевых скидок больше
    //   одной и они различаются (режимом или значением). Пустой список → discount:null
    //   (скидку счёта не трогаем).
    function _aggregateBookingDiscounts(list) {
        if (!list.length) return { discount: null, warn: false };
        const percents = list.filter(d => d.mode === 'percent');
        const amounts  = list.filter(d => d.mode === 'amount');
        let discount;
        if (percents.length) {
            discount = { mode: 'percent', value: Math.max(...percents.map(d => d.value)) };
        } else {
            discount = { mode: 'amount', value: r2(amounts.reduce((s, d) => s + d.value, 0)) };
        }
        const allSame = list.every(d => d.mode === list[0].mode && d.value === list[0].value);
        return { discount, warn: list.length > 1 && !allSame };
    }

    // ── Построение строк счёта по ОДНОЙ брони ────────────────────────────
    // Данные брони читаются из БД (шапка + ТЧ rooms/guests/roomServices/extraLines).
    // pricingDate — дата ценообразования (дата брони или дата счёта, см. fillInvoice).
    // Возвращает { lines } — строки БЕЗ invoiceId и БЕЗ сквозного sortOrder
    // (их проставляет fillInvoice).
    async function _buildInvoiceLines({ bookingId, pricingDate }, ctx) {
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
        const tInv  = (key)       => i18n.t(key, invLang);
        const tfInv = (key, vars) => i18n.tf(key, invLang, vars);

        // Счётные существительные — через формы числа (i18n.tf с `count`).
        // «1 Gäste»/«1 гостей» в юридическом документе недопустимо, а одиночное
        // заселение — штатный случай: у каждой квартиры есть цена на 1 человека.
        // Именно из-за отсутствия форм в подписях стояли сокращения («Pers.»,
        // «ÜN»), которые склонения не требуют.
        const nGuests = n => tfInv('guests_count', { count: n });
        const nNights = n => tfInv('nights_count', { count: n });

        // Разложение количества на сомножители для подписи: «2 Gäste × 3 ÜN».
        // Знак «×» законен ТОЛЬКО когда оба числа — действительно сомножители
        // графы «Количество». Прежнее «6 Gäste × 4 ÜN» при количестве 4 врало:
        // 6 не участвовало в произведении вовсе.
        const qtyBreakdown = (guests, units) =>
            tfInv('line_qty_breakdown', { guests: nGuests(guests), units });

        // Единица ВТОРОГО сомножителя у услуги. Назвать её ночами можно только по
        // ОБЪЯВЛЕННОМУ правилу услуги (quantityFormula = переменная «ночи») и только
        // если количество действительно посчитано правилом: ручной ввод правило
        // перебивает, и тогда это уже не ночи. Совпадение количества с числом ночей
        // основанием НЕ является — три массажа за три ночи не становятся ночёвками.
        // Токен берётся из реестра переменных, а не строкой в коде.
        const NIGHTS_TOKEN = (formulaEngine.VARIABLES.find(v => v.id === 'nights') || {}).token;
        const serviceUnitsLabel = (svc, rs, cnt) => {
            const f = ((svc && svc.quantityFormula) || '').trim();
            if (NIGHTS_TOKEN && f === NIGHTS_TOKEN && rs.autoQuantity !== false) return nNights(cnt);
            return String(cnt);
        };

        const guestTypes = await modelsDB.GuestTypes.findAll({ raw: true });
        const gtMap = {};
        for (const gt of guestTypes) gtMap[gt.UID] = gt;

        // Название вида гостя — из СПРАВОЧНИКА, на языке организации.
        // Дублировать его строкой в i18n.json нельзя: там оно застынет
        // («Kinder 6–13»), а границы возраста живут в guest_types и владелец
        // вправе их менять — счёт печатал бы полосу, которой уже нет.
        // findAll идёт мимо dbGateway, поэтому перевод берём явно (middleware
        // здесь не отработает и вернул бы английский base).
        const tmw = require('../../../node_modules/my-old-space/drive_root/translationMiddleware');
        const gtLookup = (invLang && invLang !== 'en')
            ? await tmw.getTranslationLookup('guest_types', invLang, modelsDB) : null;
        const gtName = gt => (gtLookup && gtLookup.get(gt.UID + '|name')) || gt.name;

        // Режим учёта вида гостя в проживании (реквизит справочника):
        //   included — входит в сетку тарифа номера;
        //   separate — своя цена проживания из прайс-листа;
        //   free     — ОБЪЯВЛЕННОЕ бесплатное проживание (младенцы).
        // Различать `free` и «цену забыли завести» обязательно: без этого
        // предупреждение об отсутствии цены срабатывало бы на каждой броне
        // с младенцем, то есть на штатной настройке, и его перестали бы читать.
        // Пустое значение (записи старше реквизита) — как `included`,
        // тот же дефолт, что в модели.
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
        for (const v of taxRateVals) rateValById[v.UID] = v.rate;

        // Полосы цен услуги для конкретной комнаты (покомнатные → иначе общие).
        const pricesForRoom = (serviceId, roomId) => {
            const rows = svcPrices.filter(p => p.serviceId === serviceId);
            const roomRows = rows.filter(p => p.roomId === roomId);
            return roomRows.length ? roomRows : rows.filter(p => p.roomId == null);
        };

        // Детский тариф проживания — сумма из прайс-листа (позиция srv-child).
        const CHILD_SERVICE_ID = 'srv-child';
        const auxPrices = priceResolver.pickServicePrices(priceSlice, { serviceId: CHILD_SERVICE_ID });
        // Полоса ищется по ВСЕМУ возрастному диапазону вида гостя (как в услугах),
        // а не по одному числу: раньше цена бралась запросом «сколько стоит гость
        // 3 лет» с фолбэком 10 € — и возраст, и сумма были вписаны в код.
        const auxPriceForGuestType = (serviceId, gt) => {
            const p = auxPrices.find(x => x.serviceId === serviceId
                && priceResolver.ageBandMatches(x, gt.ageFrom, gt.ageTo));
            return p ? Number(p.price) : 0;
        };

        const lines = [];
        let sortOrd = 0;

        // Услуги брони, которые НЕ дали ни одной строки счёта. Раньше такие услуги
        // выпадали молча (нет цены в прайсе / услуга начисляется расчётом сам) —
        // деньги пропадали из счёта без единого признака. Список уходит на клиент
        // предупреждением (см. fillInvoice / prepareFromBooking).
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
        // на срок этой брони. null — правила нет либо оно не вычисляется.
        // Тот же движок и тот же реестр переменных, что и в пересчёте брони
        // (apps/booking/forms/bookings.server.js) — второго источника правды нет.
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
        // periodCovers/validFromOrder — на уровне модуля, см. верх файла.
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
        // напр. «durchlaufender Posten § 10 Abs. 1 S. 4 UStG» для курсбора.
        // Одна и та же ставка 0% может иметь РАЗНЫЕ основания, поэтому хранить
        // достаточно ставки нельзя.
        const ACCOMMODATION_CAT = catCodeToId['accommodation'] || null;

        // Делит строку услуги на компоненты НДС (percent/amount/remainder),
        // поглощая копеечный дрейф. Логика без изменений (см. историю в booking).
        function splitLineByComponents(base, comps) {
            const qty  = base.quantity;
            const unit = base.unitPrice;
            const parts = comps.map(c => ({ c, unitPart: 0 }));
            let assigned = 0, remIdx = -1;
            for (let i = 0; i < parts.length; i++) {
                const c = parts[i].c;
                if (c.splitMode === 'remainder') { remIdx = i; continue; }
                const up = c.splitMode === 'amount'
                    ? r2(Number(c.splitValue) || 0)
                    : r2(unit * (Number(c.splitValue) || 0) / 100);
                parts[i].unitPart = up;
                assigned = r2(assigned + up);
            }
            if (remIdx >= 0) parts[remIdx].unitPart = r2(unit - assigned);
            else if (parts.length) {
                const last = parts[parts.length - 1];
                last.unitPart = r2(last.unitPart + (unit - assigned));
            }
            const out = [];
            let amtSum = 0;
            for (let i = 0; i < parts.length; i++) {
                const { c, unitPart } = parts[i];
                const amount = r2(unitPart * qty);
                out.push(Object.assign({}, base, {
                    UID: Utilities.generateUID('InvoiceLines'),
                    label: (base.label || '') + ' – ' + c.name,
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
                amtSum = r2(amtSum + amount);
            }
            const drift = r2(base.amount - amtSum);
            if (drift !== 0 && out.length) {
                let mx = 0;
                for (let i = 1; i < out.length; i++) if (out[i].amount > out[mx].amount) mx = i;
                out[mx].amount = r2(out[mx].amount + drift);
            }
            return out;
        }

        // Компонент действует, если дата услуги (заезд) попадает в validFrom..validTo.
        // Пустая граница = ограничения нет (см. periodCovers выше).
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
            const rLabel  = rInfo ? rInfo.number : '?';

            // Гости комнаты — по ВИДАМ из справочника, без корзин с порогами.
            // Раньше здесь стояла лесенка `gt.ageFrom >= 16 / 14 / 6 / 3 / 2`:
            // шесть чисел в коде, повторявших границы, которые владелец правит
            // в guest_types. Заведи он седьмой вид или сдвинь границу — расчёт
            // молча отнёс бы гостя не в ту корзину.
            const cntByGt = new Map();
            for (const g of rGuests) {
                const gt = gtMap[g.guestTypeId];
                if (!gt) continue;
                cntByGt.set(gt.UID, (cntByGt.get(gt.UID) || 0) + (g.count || 1));
            }

            // В сетку тарифа номера входят виды с режимом `included`
            // (у Seiler — от 6 лет и старше). Это правило данных, а не кода:
            // у другой организации порог другой.
            let billingGuests = 0;
            for (const gt of gtOrdered) {
                if (roomRateMode(gt) === 'included') billingGuests += (cntByGt.get(gt.UID) || 0);
            }

            // 1. Проживание — цена из среза прайс-листов.
            const rp = priceResolver.pickRoomPrice(priceSlice, {
                roomId: room.roomId, guestsCount: billingGuests, stayDate: checkInDate
            });
            if (rp) {
                lines.push({
                    UID: Utilities.generateUID('InvoiceLines'),
                    bookingId, bookingRoomId: room.UID, organizationId: orgId,
                    sectionLabel: tInv('accommodation_section'),
                    // Количество этой строки — НОЧИ, поэтому в подписи их нет:
                    // они и так стоят в графе «Количество». Число гостей, наоборот,
                    // есть только здесь — от него зависит цена, а сомножителем
                    // количества оно не является (цена уже за квартиру целиком).
                    label:    tfInv('room_line_label', { room: rLabel, guests: nGuests(billingGuests) }),
                    quantity: nights, unitPrice: rp.price,
                    taxRate:  rateByCode('accommodation', 0),
                    taxCategoryId: ACCOMMODATION_CAT,
                    amount:   r2(rp.price * nights), sortOrder: ++sortOrd
                });
            } else if (billingGuests > 0) {
                // Проживание молча выпадало из счёта, если в срезе прайс-листов
                // нет цены на такое число гостей (новый вид гостя сдвинул счёт,
                // сезон не покрыт, квартиру не внесли в прайс). Это самая
                // дорогая строка документа — молчать о её отсутствии нельзя.
                addSkipped(rLabel, 'roomnoprice', { guests: billingGuests });
            }

            // 2. Виды гостей ВНЕ тарифа номера, у которых есть собственная цена
            //    проживания (позиция прайс-листа srv-child). Раньше это были два
            //    жёстко прописанных блока «дети 3–5» и «дети 2 года» с UID видов
            //    прямо в коде. Кого накрывает цена — решает возрастная полоса
            //    позиции: младенцы под неё не попадают и строки не получают,
            //    а новый вид гостя подхватится сам, без правки кода.
            for (const gt of gtOrdered) {
                const mode = roomRateMode(gt);
                // `included` уже посчитан в тарифе номера, `free` — объявленное
                // бесплатное проживание (младенцы). Предупреждать надо только
                // про `separate`: у него ЗАЯВЛЕНА своя цена, а её нет.
                if (mode !== 'separate') continue;
                const n = cntByGt.get(gt.UID) || 0;
                if (n <= 0) continue;
                const price = auxPriceForGuestType(CHILD_SERVICE_ID, gt);
                if (!price) {
                    addSkipped(gtName(gt), 'guestnoprice');
                    continue;
                }
                const qty = n * nights;
                lines.push({
                    UID: Utilities.generateUID('InvoiceLines'),
                    bookingId, bookingRoomId: room.UID, organizationId: orgId,
                    guestTypeId: gt.UID,
                    sectionLabel: tInv('accommodation_section'),
                    // Здесь количество — человеко-ночи, и оба сомножителя известны
                    // по построению, поэтому подпись их называет.
                    label:    tfInv('room_guest_type_line_label', {
                        room: rLabel, guestType: gtName(gt),
                        guests: nGuests(n), nights: nNights(nights)
                    }),
                    quantity: qty, unitPrice: price, taxRate: rateByCode('accommodation', 0),
                    taxCategoryId: ACCOMMODATION_CAT,
                    amount:   r2(qty * price), sortOrder: ++sortOrd
                });
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
                // которую правило «только при проживании ≤ 3 ночей» начислять запрещает,
                // и ни один из двух проверяющих этого не заметил.
                const ruleQty = ruleQuantity(svc);
                if (ruleQty != null && rs.autoQuantity === false && ruleQty !== cnt) {
                    addSkipped(svc.name, 'manual', { count: cnt, expected: ruleQty });
                }
                if (!cnt) {
                    // Ноль по правилу услуги — ШТАТНОЕ состояние, а не потерянные
                    // деньги: условие услуги просто не выполнилось (уборка при
                    // проживании > 3 ночей). Решение владельца 2026-07-29: об этом
                    // не сообщать, сообщение было лишним. Предупреждаем только о
                    // РАСХОЖДЕНИИ ручного ввода с правилом (см. выше) — там счёт
                    // молча расходится с прайс-листом, и это пользователю важно.
                    continue;
                }

                // Детский тариф проживания начисляется блоком №2 ИЗ СОСТАВА ГОСТЕЙ
                // (виды вне тарифа номера × ночи). Если эта же услуга добавлена строкой
                // ТЧ брони, начисление удваивается — ровно это дал счёт 00009
                // (две строки по 75 € за одного ребёнка). Услуга-носитель цены не
                // является отдельно продаваемой: строку игнорируем и говорим об этом.
                if (rs.serviceId === CHILD_SERVICE_ID) {
                    addSkipped(svc.name, 'auto');
                    continue;
                }

                const linesBefore = lines.length;
                const roomPriceRows = pricesForRoom(rs.serviceId, room.roomId);
                // Полоса есть, если заполнена хотя бы одна граница. Прямое
                // `ageFrom != null` здесь было бы неверно: по правилу умолчаний
                // «пусто» у числа — это 0, а не NULL (см. priceResolver).
                const agePrices = roomPriceRows.filter(sp => priceResolver.hasAgeBand(sp));

                if (agePrices.length > 0) {
                    // Перебор — по справочнику видов гостей, а не по списку UID
                    // в коде: раньше шесть предопределённых видов были выписаны
                    // здесь поимённо, и седьмой просто не попал бы в счёт.
                    for (const gt of gtOrdered) {
                        const n = cntByGt.get(gt.UID) || 0;
                        if (n <= 0) continue;
                        const sp = agePrices.find(p => priceResolver.ageBandMatches(p, gt.ageFrom, gt.ageTo));
                        if (!sp || sp.price === 0) continue;
                        const qty = n * cnt;
                        const gLabel = gtName(gt);
                        const unitsLabel = serviceUnitsLabel(svc, rs, cnt);
                        const ageLabel = tfInv('service_age_group_label', {
                            name: svc.name, ageGroup: gLabel, guests: nGuests(n), units: unitsLabel
                        });
                        emitServiceLine({
                            UID: Utilities.generateUID('InvoiceLines'),
                            bookingId, bookingRoomId: room.UID, organizationId: orgId,
                            serviceId: rs.serviceId, guestTypeId: gt.UID,
                            sectionLabel: svc.name,
                            label:    ageLabel,
                            // Метка возрастной группы отдельным реквизитом: свёртка
                            // строит из неё подпись печатной строки, не разбирая
                            // готовый текст label обратно на части. Порядок — из
                            // справочника (guest_types.displayOrder), а не из
                            // порядка перебора: строки счёта идут по видам гостей.
                            _ageLabel: gLabel,
                            _ageOrder: gt.displayOrder != null ? gt.displayOrder : 50,
                            // Сомножители количества — свёртке: печатную подпись
                            // строит она, и число гостей у неё СУММИРУЕТСЯ по группе
                            // (одна ценовая полоса накрывает несколько видов гостей).
                            _persons: n, _unitsLabel: unitsLabel,
                            quantity: qty, unitPrice: sp.price, taxRate: svcRate(svc),
                            taxCategoryId: svc.taxCategoryId || null,
                            amount:   r2(qty * sp.price), sortOrder: ++sortOrd
                        }, rs.serviceId);
                    }
                } else {
                    const sp    = roomPriceRows.find(p => !priceResolver.hasAgeBand(p));
                    const price = sp ? sp.price : 0;
                    if (price > 0) {
                        const qty = cnt;
                        const svcLabel = tfInv('service_once_label', { name: svc.name, count: cnt });
                        emitServiceLine({
                            UID: Utilities.generateUID('InvoiceLines'),
                            bookingId, bookingRoomId: room.UID, organizationId: orgId,
                            serviceId: rs.serviceId, sectionLabel: svc.name,
                            label:    svcLabel,
                            quantity: qty, unitPrice: price, taxRate: svcRate(svc),
                            taxCategoryId: svc.taxCategoryId || null,
                            amount:   r2(qty * price), sortOrder: ++sortOrd
                        }, rs.serviceId);
                    }
                }

                // Услуга включена и количество задано, а строк не появилось —
                // значит в срезе прайс-листов на дату расчёта нет подходящей цены
                // (нет позиции вообще, либо возрастные полосы не накрывают гостей).
                // Молчать здесь нельзя: это недобор денег в счёте.
                if (lines.length === linesBefore) addSkipped(svc.name, 'noprice');
            }
        }

        // 6. Доп.услуги (booking_extra_lines) — прямо в счёт отдельными строками.
        for (const el of (extraLines || [])) {
            if (!el || !el.name) continue;
            const amount = Number(el.amount);
            if (!Number.isFinite(amount) || amount === 0) continue;
            const rate = el.taxRateId && rateValById[el.taxRateId] != null ? rateValById[el.taxRateId] : 0;
            lines.push({
                UID: Utilities.generateUID('InvoiceLines'),
                bookingId, organizationId: orgId,
                sectionLabel: tInv('extra_lines_section'),
                label:    el.name,
                quantity: 1, unitPrice: r2(amount),
                taxRate:  rate,
                amount:   r2(amount), sortOrder: ++sortOrd,
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
                // Те же ключи нужны свёртке: она пересобирает строки заново и
                // без них теряет порядок справочника услуг.
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
        // invLang уходит наружу: печатную подпись строк услуг собирает свёртка,
        // и язык организации нужен ей так же, как расчёту.
        return { lines, booking, skipped, invLang };
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

    // ── Свёртка детальных строк в «печатный» вид (WYSIWYG) ───────────────
    // ТЧ счёта хранит РОВНО те строки, что печатаются, — корректировать удобно.
    // Классификация как раньше в печати: услуги группируются по
    // serviceId + налоговый компонент + ставка + ЦЕНА ЗА ЕДИНИЦУ, проживание и
    // доп.строки — как есть. Порядок: проживание (по убыванию суммы)
    // → услуги (по убыванию суммы) → доп.строки.
    //
    // Цена в ключе — обязательна. Без неё возрастные полосы одной услуги
    // (курсбор 2,10 взр. / 1,00 дети 6–15; завтрак 14,50 / 8,50 / 3,50)
    // сливались в одну строку, и, поскольку общей цены за единицу у них нет,
    // строка вырождалась в «Menge 1 × вся сумма»: в счёте 1397 курсбор
    // печатался как 1 × 72,00 вместо 20 × 2,10 + 20 × 1,00 + 10 × 1,00.
    // Это прямо нарушало § 14 Abs. 4 Nr. 5 UStG (Menge и Einzelpreis —
    // самостоятельные реквизиты) и не давало гостю проверить сумму.
    // С ценой в ключе строк ровно столько, сколько сработало ценовых полос,
    // и у каждой честные количество и цена; сумма счёта не меняется.
    //
    // Подпись строки: имя услуги [+ налоговый компонент] [+ возрастные группы].
    // Группы перечисляются, потому что одна ценовая полоса может накрывать
    // несколько видов гостей (дети 6–13 и подростки 14–15 платят курсбор по 1,00).
    // Ставка НДС — ссылкой на справочник tax_rates (taxRateId); % (taxRate)
    // остаётся снапшотом документа рядом.
    function _collapseInvoiceLines(rawLines, taxRateRows, invLang) {
        // Подпись печатной строки услуги собирается ЗДЕСЬ, поэтому язык
        // организации нужен и здесь: строки счёта — содержимое документа
        // организации, а не интерфейс пользователя.
        const tfL = (key, vars) => i18n.tf(key, invLang || 'en', vars);
        const accommodation = [];
        const extra = [];
        const svcGroups = new Map(); // ключ: serviceId|компонент|ставка|категория|цена
        for (const ln of rawLines) {
            if (ln.serviceId) {
                const rate = ln.taxRate || 0;
                const comp = ln.taxComponentName || '';
                const unit = Number(ln.unitPrice) || 0;
                // Категория — часть ключа: одинаковая ставка с РАЗНЫМ основанием
                // (0% durchlaufender Posten vs 0% § 4 Nr. 12a) не должна сливаться.
                const key = ln.serviceId + '|' + comp + '|' + rate + '|' + (ln.taxCategoryId || '') + '|' + unit;
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
            const amount = r2(g.rows.reduce((s, r) => s + (Number(r.amount) || 0), 0));
            const qtySum = r2(g.rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0));
            // Цена входит в ключ группы, поэтому она одна на все строки —
            // количество всегда суммируется, вырожденного «1 × вся сумма» нет.
            // Вид гостя — перед налоговым компонентом: строки одного гостя
            // должны читаться подряд («… — Erwachsener – Speisen», «… —
            // Erwachsener – Getränke»), а не разбиваться по еде и напиткам.
            let label = g.base;
            if (g.ages.length) {
                label += ' — ' + g.ages.slice()
                    .sort((a, b) => a.order - b.order).map(a => a.label).join(', ');
            }
            if (g.comp) label += ' – ' + g.comp;
            // Разложение количества — в конце: «Kurbeitrag — Erwachsener (2 Gäste × 3 ÜN)».
            // Без него графа «Количество» показывала бы 6 без единого объяснения,
            // откуда шестёрка (2 гостя × 3 ночи).
            if (g.persons > 0 && g.unitsLabel && !g.unitsMixed) {
                label += ' (' + tfL('line_qty_breakdown', {
                    guests: tfL('guests_count', { count: g.persons }),
                    units:  g.unitsLabel
                }) + ')';
            }
            services.push({
                UID: Utilities.generateUID('InvoiceLines'),
                bookingId:        g.proto.bookingId,
                organizationId:   g.proto.organizationId,
                serviceId:        g.proto.serviceId,
                guestTypeId:      g.rows.length === 1 ? (g.proto.guestTypeId || null) : null,
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
        // Строки одной услуги обязаны идти подряд. Сортировка по одной лишь
        // сумме их перемешивала: в счёте 1396 курсбор вставал между «Frühstück
        // – Speisen» и «Frühstück – Getränke», потому что его 33,60 попадали
        // между ними по величине. Порядок: услуга (displayOrder справочника,
        // при равенстве — по названию) → вид гостя (displayOrder справочника)
        // → налоговый компонент → сумма. Вид гостя ВЫШЕ компонента: гость
        // сверяет счёт по людям, а не по ставкам НДС.
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
            const rr = taxRateRows.find(r => Number(r.rate) === Number(ln.taxRate || 0));
            ln.taxRateId = rr ? rr.UID : null;
            if (rr) ln.__taxRateId_display = rr.name;
            if (ln.serviceId && ln.sectionLabel) ln.__serviceId_display = ln.sectionLabel;
        }
        return out;
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
            const { lines, skipped, invLang } = await _buildInvoiceLines({ bookingId, pricingDate }, ctx);
            for (const s of (skipped || [])) {
                if (!allSkipped.some(x => x.service === s.service && x.reason === s.reason)) allSkipped.push(s);
            }
            prepaymentSum = r2(prepaymentSum + (Number(booking.prepayment) || 0));

            // Скидка брони-основания (переносится в счёт, см. агрегацию ниже).
            const dv = Number(booking.discountValue) || 0;
            if (dv > 0) bookingDiscounts.push({ mode: booking.discountMode || 'percent', value: dv });

            // ТЧ хранит свёрнутые «печатные» строки (WYSIWYG) — детализация по
            // возрастным группам схлопывается здесь же, как раньше в печати.
            allLines.push(..._collapseInvoiceLines(lines, taxRateRows, invLang));
        }
        const { discount: aggDiscount, warn: discWarn } = _aggregateBookingDiscounts(bookingDiscounts);
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
        // Скидка — ровно то же правило: ненулевая скидка В СЧЁТЕ сильнее
        // агрегата по броням. Раньше правило было односторонним (агрегат
        // применялся, как только у любой брони скидка ненулевая) — и счёт с
        // согласованной вручную скидкой молча получал другую при нажатии
        // «Заполнить».
        const invUpdate = {};
        const keepPrepayment = (Number(invoice.prepayment) || 0) !== 0;
        const keepDiscount   = (Number(invoice.discountValue) || 0) !== 0;
        if (!keepPrepayment) invUpdate.prepayment = prepaymentSum;
        if (aggDiscount && !keepDiscount) {
            invUpdate.discountMode  = aggDiscount.mode;
            invUpdate.discountValue = aggDiscount.value;
        }
        if (Object.keys(invUpdate).length) {
            await dbGateway.execute({
                operation: 'update', table: 'invoices',
                where: { UID: invoiceId }, data: invUpdate,
                context: dbCtx
            });
        }

        // Предупреждение пользователю (язык сессии — это UI-алерт, не документ):
        // у нескольких броней-оснований разные скидки, объединены в одну.
        // Только если скидку действительно применили: если она осталась своя,
        // сообщение про объединение скидок броней относилось бы к тому, чего
        // не произошло.
        let discountNotice = null;
        if (discWarn && aggDiscount && !keepDiscount) {
            const disp = aggDiscount.mode === 'percent'
                ? (aggDiscount.value + ' %') : (aggDiscount.value + ' €');
            discountNotice = await tfForSession('discount_multi_booking_warning', ctx.sessionID, { discount: disp });
        }

        notifyTables('update', invoiceId);
        const freshInvoice = await modelsDB.Invoices.findByPk(invoiceId, { raw: true });
        const skippedNotice = await _skippedNotice(allSkipped, ctx.sessionID);
        return { invoice: freshInvoice, lines: allLines, discountNotice, skippedNotice };
    }

    return {

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
        async prepareFromBooking({ bookingId }, ctx) {
            if (!bookingId) return { error: await tForSession('booking_not_found', ctx.sessionID) };
            const booking = await modelsDB.Bookings.findByPk(bookingId, { raw: true });
            if (!booking) return { error: await tForSession('booking_not_found', ctx.sessionID) };

            try {
                const mode = await resolveOrgPricingMode(modelsDB, booking.organizationId);
                // Дата счёта появится только при сохранении — в режиме invoiceDate
                // берём текущий момент (его же поставит хук default.documentDate).
                const pricingDate = (mode === 'invoiceDate')
                    ? new Date()
                    : (booking.date || new Date());
                const { lines, skipped, invLang } = await _buildInvoiceLines({ bookingId, pricingDate }, ctx);
                const taxRateRows = await modelsDB.TaxRates.findAll({ raw: true });
                const collapsed = _collapseInvoiceLines(lines, taxRateRows, invLang);
                collapsed.forEach((ln, i) => { ln.sortOrder = i + 1; });

                return {
                    skippedNotice: await _skippedNotice(skipped, ctx.sessionID),
                    prefill: {
                        organizationId: booking.organizationId,
                        hotelId:        booking.hotelId,
                        clientId:       booking.clientId,
                        status:         'draft',
                        prepayment:     Number(booking.prepayment) || 0,
                        // Скидка переносится из брони (одна бронь — без агрегации).
                        discountMode:   booking.discountMode || 'percent',
                        discountValue:  Number(booking.discountValue) || 0
                    },
                    prefillTabular: {
                        invoice_bookings: [{
                            organizationId: booking.organizationId,
                            bookingId
                        }],
                        invoice_lines: collapsed
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
        async onBeforeSave({ record, changes, tabularSections, parentUID }, ctx) {
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

            // Скидка счёта: пустое/нечисло → 0, отрицательное → 0; режим по умолчанию.
            if ('discountValue' in changes) {
                const dv = Number(changes.discountValue);
                changes.discountValue = Number.isFinite(dv) ? Math.max(0, dv) : 0;
            }
            if ('discountMode' in changes && !changes.discountMode) changes.discountMode = 'percent';

            const lines = tabularSections.invoice_lines || [];
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
                        row.amount = r2(qty * unit);
                    }
                    if (row.quantity  == null) row.quantity  = 0;
                    if (row.unitPrice == null) row.unitPrice = 0;
                    if (row.amount    == null) row.amount    = 0;
                    if (row.taxRate   == null) row.taxRate   = 0;
                    if (row.sortOrder == null) row.sortOrder = 0;
                }
            }
        }

    };
};
