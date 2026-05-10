/**
 * Файл для обработки событий проекта.
 * Переопределяет или дополняет стандартное поведение фреймворка.
 */

module.exports = {
    /**
     * Вызывается после сбора и слияния моделей, но до инициализации в Sequelize.
     * @param {Object} context - { mergedModelsDef, allAssociations, sequelize, projectRoot }
     */
    onModelsPostCollect: async function(context) {
        const { mergedModelsDef } = context;
        if (!Array.isArray(mergedModelsDef)) return;

        for (const def of mergedModelsDef) {
            if (!def.fields) def.fields = {};

            // Remove any other primary keys (besides UID)
            for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
                if (fieldName !== 'UID' && fieldDef && fieldDef.primaryKey) {
                    delete fieldDef.primaryKey;
                }
            }

            // Inject UID as the sole primary key if not explicitly defined
            if (!def.fields.UID) {
                def.fields.UID = {
                    type: "STRING",
                    allowNull: false,
                    primaryKey: true,
                    defaultValue: "GENERATE_UID"
                };
            } else {
                def.fields.UID.primaryKey = true;
                def.fields.UID.allowNull = false;
                def.fields.UID.type = "STRING";
                if (!def.fields.UID.defaultValue) {
                    def.fields.UID.defaultValue = "GENERATE_UID";
                }
            }
        }
        console.log(`[events_handler] UID injected into ${mergedModelsDef.length} model definitions.`);
    },

    /**
     * Вызывается после завершения каскадного формирования базы данных (миграций и сидов).
     * @param {Object} context - Контекст инициализации (sequelize instance и т.д.)
     */
    onDatabasePostInit: async function(context) {
        console.log('[events_handler] Database post-initialization hook executed.');
        // Проставить displayOrder предопределённым типам гостей (только если ещё null)
        try {
            const { sequelize } = context;
            const GuestTypes = sequelize && sequelize.models && sequelize.models.GuestTypes;
            if (GuestTypes) {
                const updates = [
                    { UID: '000000000-guest-type-0003', displayOrder: 20 }, // Kinder 3-5 → доп. плата
                    { UID: '000000000-guest-type-0005', displayOrder: 25 }, // Kind 2 J. → доп. плата
                    { UID: '000000000-guest-type-0004', displayOrder: 30 }, // Kleinkind → доп. плата
                    { UID: '000000000-guest-type-0001', displayOrder: 40 }, // Erwachsener → Kurtaxe
                    { UID: '000000000-guest-type-0002', displayOrder: 42 }, // Kind 6-15 → Kurtaxe
                ];
                for (const u of updates) {
                    await GuestTypes.update(
                        { displayOrder: u.displayOrder },
                        { where: { UID: u.UID, displayOrder: null } }
                    );
                }
                console.log('[events_handler] Guest type displayOrder initialized.');
            }
        } catch (e) {
            console.warn('[events_handler] Could not set guest type displayOrder:', e && e.message);
        }
    },
};
