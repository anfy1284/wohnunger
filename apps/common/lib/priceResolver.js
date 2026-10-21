'use strict';

// ─────────────────────────────────────────────────────────────────────
// Резолвер цен по документам «Прайс-лист» (price_lists) — единая точка.
//
// Цены проживания и услуг задаются ДОКУМЕНТАМИ прайс-листов и действуют
// с даты документа (price_lists.date). Разрешение — «срез последних» по
// ПОЗИЦИИ (как в учётных системах): для позиции берётся строка из самого позднего
// документа организации/отеля с date <= pricingDate, содержащего эту
// позицию. Документ не обязан повторять весь прайс — может устанавливать
// только изменившиеся позиции.
//
// Ключ позиции проживания: roomId + guestsCount + сезон (справочник seasons;
// строка применима, если ОДИН ИЗ периодов её сезона (ТЧ season_periods,
// dateFrom..dateTo) накрывает дату проживания).
// Ключ позиции услуги: serviceId + roomId + возрастная полоса.
//
// Все консьюмеры цен (расчёт строк счёта, контроль заполняемости брони)
// обязаны ходить сюда, а не в таблицы напрямую.
//
// Работает прямыми Sequelize-запросами (как расчёт счёта) — фильтрация
// по organizationId выполняется здесь вручную, RLS-контекст не участвует.
//
// Использование (батчево, без запросов в циклах):
//   const priceResolver = require('../../common/lib/priceResolver')(modelsDB);
//   const slice = await priceResolver.loadSlice({ organizationId, hotelId, pricingDate });
//   const rp = priceResolver.pickRoomPrice(slice, { roomId, guestsCount, stayDate });
//   const bands = priceResolver.pickServicePrices(slice, { serviceId });
// Или одиночные вызовы (сами грузят срез):
//   await priceResolver.resolveRoomPrice({ organizationId, hotelId, roomId, guestsCount, stayDate, pricingDate })
//   await priceResolver.resolveServicePrices({ organizationId, hotelId, serviceId, pricingDate })
// ─────────────────────────────────────────────────────────────────────

const { Op } = require('sequelize');
// Пустая дата в проекте — 0001-01-01, а не NULL (drive_root/db/emptyValues.js).
const { isEmptyDate } = require('../../../node_modules/my-old-space/drive_root/db/emptyValues');
const M = require('../../../node_modules/my-old-space/drive_root/db/money');

// ── Пустой возраст: 0 и NULL — одно и то же ──────────────────────────
// Правило проекта: NULL в базе допустим только у полей-ссылок, у числа
// «пусто» — это 0 (см. ИНСТРУКЦИИ_ДЛЯ_AI.md, «Классические учётные системы —
// глобальный образец»).
// Возрастные границы — числа, поэтому «ограничения нет» = 0.
//
// Почему это ОБЯЗАНО жить здесь, а не у каждого потребителя: разночтение
// «0 или NULL» уже стоило пропавшей из счёта платы за собаку. Строка с
// границами 0..0 трактовалась как полоса «от нуля до нуля лет», под
// которую не подходит ни один гость, услуга молча давала ноль, а позиция
// при этом считалась ОТДЕЛЬНОЙ от старой (с NULL) — и новая цена не
// заменяла прежнюю, а вставала рядом.
//
// В базе одновременно лежат NULL (записаны после правки круга 2) и нули
// (записаны до неё и после введения правила умолчаний). Обе формы обязаны
// схлопываться в одну позицию — иначе миграция значений сама породит
// дубли позиций.
const isEmptyAge = v => v == null || Number(v) === 0;

// Нормализованная граница: пусто → 0. Для ключа позиции и сравнений.
const ageNum = v => (isEmptyAge(v) ? 0 : Number(v));

// Есть ли у строки возрастная полоса вообще.
// Нет полосы = обе границы пусты. Полоса «0..1» (младенцы) полосой
// является — у неё заполнена верхняя граница.
const hasAgeBand = row => !(isEmptyAge(row.ageFrom) && isEmptyAge(row.ageTo));

// Подходит ли полоса строки под возрастной диапазон гостя.
// ageTo = 0 при заполненном ageFrom означает «верхней границы нет»,
// а не «до нуля лет».
function ageBandMatches(row, guestAgeFrom, guestAgeTo) {
    const from = ageNum(row.ageFrom);
    const to   = isEmptyAge(row.ageTo) ? Infinity : Number(row.ageTo);
    const gFrom = ageNum(guestAgeFrom);
    const gTo   = guestAgeTo != null && Number(guestAgeTo) !== 0 ? Number(guestAgeTo) : gFrom;
    return from <= gFrom && to >= gTo;
}

module.exports = function (modelsDB) {

    // ── Срез прайс-листов на дату ценообразования ────────────────────
    // Четыре запроса: документы + обе ТЧ всех подходящих документов +
    // периоды сезонов организации (справочник seasons, ТЧ season_periods).
    // docs отсортированы по date DESC (при равенстве — по createdAt DESC),
    // строки ТЧ несут _docIdx (0 = самый поздний документ).
    // seasonPeriods: { seasonId: [{ dateFrom, dateTo }, ...] }.
    async function loadSlice({ organizationId, hotelId, pricingDate }) {
        const empty = { docs: [], roomRows: [], svcRows: [], guestRows: [], seasonPeriods: {} };
        if (!organizationId) return empty;
        const till = pricingDate ? new Date(pricingDate) : new Date();
        if (isNaN(till.getTime())) return empty;

        const where = { organizationId, date: { [Op.lte]: till } };
        if (hotelId) where.hotelId = hotelId;
        const docs = await modelsDB.PriceLists.findAll({ where, raw: true });
        if (!docs.length) return empty;
        docs.sort((a, b) => {
            const d = new Date(b.date) - new Date(a.date);
            if (d) return d;
            return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
        });
        const docIdx = {};
        docs.forEach((doc, i) => { docIdx[doc.UID] = i; });
        const docIds = docs.map(doc => doc.UID);

        const [roomRows, svcRows, guestRows, periodRows] = await Promise.all([
            modelsDB.PriceListRoomPrices.findAll({ where: { priceListId: docIds }, raw: true }),
            modelsDB.PriceListServicePrices.findAll({ where: { priceListId: docIds }, raw: true }),
            modelsDB.PriceListGuestTypePrices
                ? modelsDB.PriceListGuestTypePrices.findAll({ where: { priceListId: docIds }, raw: true })
                : [],
            modelsDB.SeasonPeriods.findAll({ where: { organizationId }, raw: true })
        ]);
        // Цена нормализуется в ЧИСЛО здесь, в единственной точке доступа к
        // ценам. Колонка — DECIMAL, а драйвер postgres отдаёт её строкой
        // («120.00»): без нормализации каждый потребитель складывал бы строки
        // (склейка вместо суммы) и сравнивал бы их лексикографически
        // («9.00» > «10.00»). Резолвер — то самое место, где это чинится один
        // раз для всех.
        for (const r of roomRows) { r._docIdx = docIdx[r.priceListId]; r.price = M.num(r.price); }
        for (const r of svcRows)  { r._docIdx = docIdx[r.priceListId]; r.price = M.num(r.price); }
        for (const r of guestRows) { r._docIdx = docIdx[r.priceListId]; r.price = M.num(r.price); }
        // Сезон принадлежит ОТЕЛЮ (решение владельца 16.10.2026): при расчёте для
        // отеля периоды чужих сезонов не действуют, даже если строка прайс-листа
        // по ошибке на такой сезон ссылается.
        let hotelSeasonIds = null;
        if (hotelId) {
            const hs = await modelsDB.Seasons.findAll({ where: { organizationId, hotelId }, attributes: ['UID'], raw: true });
            hotelSeasonIds = new Set(hs.map(r => r.UID));
        }
        const seasonPeriods = {};
        for (const p of periodRows) {
            if (hotelSeasonIds && !hotelSeasonIds.has(p.seasonId)) continue;
            (seasonPeriods[p.seasonId] = seasonPeriods[p.seasonId] || []).push(p);
        }
        return { docs, roomRows, svcRows, guestRows, seasonPeriods };
    }

    // ── Цена проживания из среза ─────────────────────────────────────
    // Позиция: roomId + guestsCount + сезон (один из периодов сезона
    // накрывает stayDate, границы включительно).
    // Побеждает строка самого позднего документа, содержащего позицию.
    function seasonCoversDay(slice, seasonId, day) {
        const periods = seasonId && slice.seasonPeriods && slice.seasonPeriods[seasonId];
        if (!periods) return false;
        for (const p of periods) {
            // Незаполненный период не накрывает ничего. Проверять через
            // isEmptyDate обязательно: пустая дата — 0001-01-01, и без
            // проверки такой период накрыл бы всё «с начала времён».
            if (isEmptyDate(p.dateFrom) || isEmptyDate(p.dateTo)) continue;
            if (new Date(p.dateFrom) <= day && new Date(p.dateTo) >= day) return true;
        }
        return false;
    }

    function pickRoomPrice(slice, { roomId, guestsCount, stayDate }) {
        if (!slice || !roomId || !stayDate) return null;
        const day = new Date(stayDate);
        if (isNaN(day.getTime())) return null;
        let best = null;
        for (const r of slice.roomRows) {
            if (r.roomId !== roomId) continue;
            if (Number(r.guestsCount) !== Number(guestsCount)) continue;
            if (!seasonCoversDay(slice, r.seasonId, day)) continue;
            if (!best || r._docIdx < best._docIdx) best = r;
        }
        return best ? { price: best.price, priceListId: best.priceListId } : null;
    }

    // ── Актуальные полосы цен услуги из среза ────────────────────────
    // Возвращает «срез последних» по позициям услуги: для каждой позиции
    // (roomId + возрастная полоса) — строка самого позднего документа.
    // Выбор полосы по возрасту/комнате остаётся за вызывающим кодом
    // (логика pricesForRoom/agePrices в расчёте счёта сохраняется).
    function pickServicePrices(slice, { serviceId }) {
        if (!slice || !serviceId) return [];
        const byPos = new Map();
        for (const r of slice.svcRows) {
            if (r.serviceId !== serviceId) continue;
            // Границы нормализуются (пусто → 0), поэтому строка с NULL и
            // строка с 0 — ОДНА позиция: более поздний документ заменяет
            // более ранний, а не создаёт вторую позицию рядом.
            const key = `${r.roomId || ''}|${ageNum(r.ageFrom)}|${ageNum(r.ageTo)}`;
            const cur = byPos.get(key);
            if (!cur || r._docIdx < cur._docIdx) byPos.set(key, r);
        }
        return Array.from(byPos.values());
    }

    // ── Цена ночи гостя вида вне тарифа номера ───────────────────────
    // Вкладка прайс-листа «Preise nach Gästeart» (19.10.2026). Позиция:
    // вид гостя + номер (пусто = все номера) + сезон (пусто = круглый год).
    // По каждой позиции — строка самого позднего документа; из подходящих
    // позиций побеждает ТОЧНЕЙШАЯ: свой номер сильнее «всех номеров», сезон
    // сильнее «круглого года» — так же, как покомнатная цена услуги сильнее
    // общей. Сезон строки применим, если один из его периодов накрывает ночь.
    function pickGuestTypePrice(slice, { guestTypeId, roomId, stayDate }) {
        if (!slice || !guestTypeId || !stayDate) return null;
        const day = new Date(stayDate);
        if (isNaN(day.getTime())) return null;
        const byPos = new Map();
        for (const r of (slice.guestRows || [])) {
            if (r.guestTypeId !== guestTypeId) continue;
            const key = `${r.roomId || ''}|${r.seasonId || ''}`;
            const cur = byPos.get(key);
            if (!cur || r._docIdx < cur._docIdx) byPos.set(key, r);
        }
        let best = null, bestRank = -1;
        for (const r of byPos.values()) {
            if (r.roomId && r.roomId !== roomId) continue;
            if (r.seasonId && !seasonCoversDay(slice, r.seasonId, day)) continue;
            const rank = (r.roomId ? 2 : 0) + (r.seasonId ? 1 : 0);
            if (rank > bestRank || (rank === bestRank && r._docIdx < best._docIdx)) { best = r; bestRank = rank; }
        }
        return best ? { price: best.price, priceListId: best.priceListId } : null;
    }

    // ── Одиночные вызовы (сами грузят срез) ──────────────────────────
    async function resolveRoomPrice({ organizationId, hotelId, roomId, guestsCount, stayDate, pricingDate }) {
        const slice = await loadSlice({ organizationId, hotelId, pricingDate });
        return pickRoomPrice(slice, { roomId, guestsCount, stayDate });
    }

    async function resolveServicePrices({ organizationId, hotelId, serviceId, pricingDate }) {
        const slice = await loadSlice({ organizationId, hotelId, pricingDate });
        return pickServicePrices(slice, { serviceId });
    }

    return {
        loadSlice, pickRoomPrice, pickServicePrices, pickGuestTypePrice, resolveRoomPrice, resolveServicePrices,
        // Работа с возрастными границами — только через эти помощники.
        // Прямые сравнения `ageFrom != null` в коде потребителей запрещены:
        // они не видят разницы между «пусто» и «ноль».
        isEmptyAge, ageNum, hasAgeBand, ageBandMatches
    };
};
