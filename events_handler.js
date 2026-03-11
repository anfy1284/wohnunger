/**
 * Файл для обработки событий фреймворка my-old-space.
 * Сюда будут добавляться обработчики жизненного цикла приложений, 
 * событий форм и взаимодействия с данными.
 */

// Placeholder для будущих обработчиков
export default {
    /**
     * Вызывается после сбора и слияния моделей, но до инициализации в Sequelize.
     * @param {Object} context - { mergedModelsDef, allAssociations, sequelize, projectRoot }
     */
    onModelsPostCollect: async (context) => {
        const { mergedModelsDef } = context;
        if (!mergedModelsDef) return;

        for (const def of mergedModelsDef) {
            // Удаляем старые primaryKey у всех полей
            for (const [fieldName, fieldDef] of Object.entries(def.fields || {})) {
                if (fieldName !== 'UID' && fieldDef.primaryKey) {
                    delete fieldDef.primaryKey;
                }
            }

            // Энжектим UID как единственный Primary Key  
            if (!def.fields) def.fields = {};
            
            // Функция генерации UID
            const uidGenerator = function() {
                try {
                    const util = require('./node_modules/my-old-space/drive_root/db/utilites');
                    return util.generateUID(def.name || def.tableName || 'model');
                } catch(e) {
                    const time = Date.now().toString(36).padStart(9, '0').slice(-9);
                    const hash = '0000000';
                    const random = require('crypto').randomBytes(6).readUIntBE(0, 6).toString(36).padStart(7, '0').slice(-7);
                    return `${time}-${hash}-${random}`;
                }
            };

            if (!def.fields.UID) {
                def.fields.UID = {
                    type: "STRING",
                    allowNull: false,
                    primaryKey: true,
                    defaultValue: uidGenerator
                };
            } else {
                def.fields.UID.primaryKey = true;
                def.fields.UID.allowNull = false;
                def.fields.UID.type = "STRING";
                if (!def.fields.UID.defaultValue || def.fields.UID.defaultValue === "GENERATE_UID") {
                    def.fields.UID.defaultValue = uidGenerator;
                }
            }
        }
        console.log('[events_handler] Models post-collect hook executed. UID injected.');
    },

    /**
     * Вызывается после завершения каскадного формирования базы данных (миграций и сидов).
     * @param {Object} context - Контекст инициализации (sequelize instance и т.д.)
     */
    onDatabasePostInit: async (context) => {
        console.log('[events_handler] Database post-initialization hook executed.');
        // Здесь можно добавить проверку данных или дополнительную инициализацию
    },

    // onAppStart: (app) => { ... },
    // onFormOpen: (form) => { ... },
};
