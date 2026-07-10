'use strict';

// ─────────────────────────────────────────────────────────────────────
// Резолвер цен по документам «Прайс-лист» (price_lists) — единая точка.
//
// Цены проживания и услуг задаются ДОКУМЕНТАМИ прайс-листов и действуют
// с даты документа (price_lists.date). Разрешение — «срез последних» по
// ПОЗИЦИИ (как в 1С): для позиции берётся строка из самого позднего
// документа организации/отеля с date <= pricingDate, содержащего эту
// позицию. Документ не обязан повторять весь прайс — может устанавливать
// только изменившиеся позиции.
//
// Ключ позиции проживания: roomId + guestsCount + сезон (строка применима,
// если её сезонный интервал dateFrom..dateTo накрывает дату проживания).
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

module.exports = function (modelsDB) {

    // ── Срез прайс-листов на дату ценообразования ────────────────────
    // Три запроса: документы + обе ТЧ всех подходящих документов.
    // docs отсортированы по date DESC (при равенстве — по createdAt DESC),
    // строки ТЧ несут _docIdx (0 = самый поздний документ).
    async function loadSlice({ organizationId, hotelId, pricingDate }) {
        const empty = { docs: [], roomRows: [], svcRows: [] };
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

        const [roomRows, svcRows] = await Promise.all([
            modelsDB.PriceListRoomPrices.findAll({ where: { priceListId: docIds }, raw: true }),
            modelsDB.PriceListServicePrices.findAll({ where: { priceListId: docIds }, raw: true })
        ]);
        for (const r of roomRows) r._docIdx = docIdx[r.priceListId];
        for (const r of svcRows)  r._docIdx = docIdx[r.priceListId];
        return { docs, roomRows, svcRows };
    }

    // ── Цена проживания из среза ─────────────────────────────────────
    // Позиция: roomId + guestsCount + сезон (интервал накрывает stayDate).
    // Побеждает строка самого позднего документа, содержащего позицию.
    function pickRoomPrice(slice, { roomId, guestsCount, stayDate }) {
        if (!slice || !roomId || !stayDate) return null;
        const day = new Date(stayDate);
        if (isNaN(day.getTime())) return null;
        let best = null;
        for (const r of slice.roomRows) {
            if (r.roomId !== roomId) continue;
            if (Number(r.guestsCount) !== Number(guestsCount)) continue;
            if (new Date(r.dateFrom) > day || new Date(r.dateTo) < day) continue;
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
            const key = `${r.roomId || ''}|${r.ageFrom != null ? r.ageFrom : ''}|${r.ageTo != null ? r.ageTo : ''}`;
            const cur = byPos.get(key);
            if (!cur || r._docIdx < cur._docIdx) byPos.set(key, r);
        }
        return Array.from(byPos.values());
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

    return { loadSlice, pickRoomPrice, pickServicePrices, resolveRoomPrice, resolveServicePrices };
};
