'use strict';

// ─────────────────────────────────────────────────────────────────────
// Резолв языка ДОКУМЕНТОВ организации (счёт/отчёты).
//
// Счёт — документ организации, а не пользователя: он ВСЕГДА формируется на
// языке организации (organizationSettings → reportLanguage → languages.code),
// независимо от того, какой язык интерфейса выбрал текущий пользователь.
// Используется и при печати счёта (reports), и при построении строк счёта
// (invoice _buildInvoiceLines) — чтобы и шапка, и тексты строк были на одном,
// «организационном» языке. По умолчанию — немецкий ('de').
// ─────────────────────────────────────────────────────────────────────

async function resolveOrgReportLang(modelsDB, orgId) {
    let lang = 'de';
    try {
        if (orgId && modelsDB && modelsDB.OrganizationSettingsFields && modelsDB.OrganizationSettingsStringValues) {
            const langField = await modelsDB.OrganizationSettingsFields.findOne({ where: { name: 'reportLanguage' }, raw: true });
            if (langField) {
                const rec = await modelsDB.OrganizationSettingsStringValues.findOne({
                    where: { organizationId: orgId, settingsFieldId: langField.UID }, raw: true
                });
                if (rec && rec.value && modelsDB.Languages) {
                    const langRow = await modelsDB.Languages.findByPk(rec.value, { raw: true });
                    if (langRow && langRow.code) lang = langRow.code;
                }
            }
        }
    } catch (e) {
        console.warn('[orgReportLanguage] resolve failed:', e && e.message);
    }
    return lang;
}

module.exports = { resolveOrgReportLang };
