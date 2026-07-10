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
// По образцу orgReportLanguage.js.
// ─────────────────────────────────────────────────────────────────────

const MODES = ['bookingDate', 'invoiceDate'];

async function resolveOrgPricingMode(modelsDB, orgId) {
    let mode = 'bookingDate';
    try {
        if (orgId && modelsDB && modelsDB.OrganizationSettingsFields && modelsDB.OrganizationSettingsStringValues) {
            const field = await modelsDB.OrganizationSettingsFields.findOne({ where: { name: 'pricingDateMode' }, raw: true });
            if (field) {
                const rec = await modelsDB.OrganizationSettingsStringValues.findOne({
                    where: { organizationId: orgId, settingsFieldId: field.UID }, raw: true
                });
                if (rec && rec.value && MODES.includes(rec.value)) mode = rec.value;
            }
        }
    } catch (e) {
        console.warn('[orgPricingMode] resolve failed:', e && e.message);
    }
    return mode;
}

module.exports = { resolveOrgPricingMode };
