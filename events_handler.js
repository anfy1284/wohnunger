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
    },
};
