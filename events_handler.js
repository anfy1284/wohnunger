/**
 * Файл для обработки событий проекта.
 * Переопределяет или дополняет стандартное поведение фреймворка.
 */

// Placeholder для будущих обработчиков
export default {
    /**
     * Вызывается после сбора и слияния моделей, но до инициализации в Sequelize.
     * @param {Object} context - { mergedModelsDef, allAssociations, sequelize, projectRoot }
     */
    onModelsPostCollect: async (context) => {
        // Логика инъекции UID перенесена во фреймворк.
        // Здесь можно добавить специфичную для проекта логику предобработки моделей.
        console.log('[Project events_handler] Models post-collect hook executed.');
    },

    /**
     * Вызывается после завершения каскадного формирования базы данных (миграций и сидов).
     * @param {Object} context - Контекст инициализации (sequelize instance и т.д.)
     */
    onDatabasePostInit: async (context) => {
        console.log('[Project events_handler] Database post-initialization hook executed.');
    },

    // onAppStart: (app) => { ... },
    // onFormOpen: (form) => { ... },
};
