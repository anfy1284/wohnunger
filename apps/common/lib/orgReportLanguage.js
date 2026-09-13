'use strict';

// ─────────────────────────────────────────────────────────────────────
// Резолв языка ДОКУМЕНТОВ организации (счёт/отчёты).
//
// Счёт — документ организации, а не пользователя: он ВСЕГДА формируется на
// языке организации, независимо от того, какой язык интерфейса выбрал текущий
// пользователь. Используется и при печати счёта (reports), и при построении
// строк счёта (invoice _buildInvoiceLines) — чтобы и шапка, и тексты строк были
// на одном, «организационном» языке. По умолчанию — немецкий ('de').
//
// Значение читается из общего механизма настроек: настройка `project.reportLanguage`
// (уровень «организация»), объявлена в корневом `settings.json` проекта — язык
// документов читают и счета, и отчёты, поэтому хозяина-приложения у неё нет.
//
// Аргумент `modelsDB` сохранён: функцию зовут из нескольких мест, и менять её
// сигнатуру ради внутренней перестройки незачем.
// ─────────────────────────────────────────────────────────────────────

const settings = require('../../../node_modules/my-old-space/drive_root/settings');

async function resolveOrgReportLang(modelsDB, orgId) {
    let lang = 'de';
    try {
        if (!orgId) return lang;
        const langUID = await settings.getRecordSetting('organization', orgId, 'project', 'reportLanguage');
        if (langUID && modelsDB && modelsDB.Languages) {
            const langRow = await modelsDB.Languages.findByPk(String(langUID), { raw: true });
            if (langRow && langRow.code) lang = langRow.code;
        }
    } catch (e) {
        console.warn('[orgReportLanguage] resolve failed:', e && e.message);
    }
    return lang;
}

module.exports = { resolveOrgReportLang };
