'use strict';

// ─────────────────────────────────────────────────────────────────────
// Резолв режима даты ценообразования организации (pricingDateMode).
//
// Определяет, на какую дату берётся срез прайс-листов (priceResolver)
// при построении строк счёта:
//   'bookingDate' — по дате документа БРОНИ (bookings.date); для каждой
//                   брони в счёте — своя дата (по умолчанию);
//   'invoiceDate' — по дате документа СЧЁТА (invoices.date); одна на весь счёт.
//
// Контроль заполняемости брони всегда использует дату брони (на момент
// проверки счёта ещё нет) — он этот хелпер не вызывает.
//
// Значение читается из общего механизма настроек: настройка `common.pricingDateMode`
// (уровень «организация») — объявлена в `apps/common`, где живёт `priceResolver`.
// ─────────────────────────────────────────────────────────────────────

const settings = require('../../../node_modules/my-old-space/drive_root/settings');

const MODES = ['bookingDate', 'invoiceDate'];

async function resolveOrgPricingMode(modelsDB, orgId) {
    let mode = 'bookingDate';
    try {
        if (!orgId) return mode;
        const value = await settings.getRecordSetting('organization', orgId, 'common', 'pricingDateMode');
        if (value && MODES.includes(value)) mode = value;
    } catch (e) {
        console.warn('[orgPricingMode] resolve failed:', e && e.message);
    }
    return mode;
}

module.exports = { resolveOrgPricingMode };
