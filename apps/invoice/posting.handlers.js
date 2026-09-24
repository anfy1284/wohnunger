'use strict';

/**
 * Обработчик проведения счёта («выставить» = «провести», ТЗ §5.3).
 *
 * ФАЙЛ ГРУЗЯТ ДВА ПРОЦЕССА — главный и форкнутый воркер планировщика, который и
 * выполняет проведение, — поэтому модуль обязан быть ЧИСТОЙ ФАБРИКОЙ без
 * побочных эффектов. Регистрация в `init.js` (`entityHooks.register`) для
 * проведения не годится: `init.js` выполняет только главный процесс, и в воркере
 * обработчика не существует. Подробности: `drive_root/db/postingHandlers.js`.
 *
 * Фабрика счёта (`forms/invoices.server.js`) тяжёлая, но чистая: она ничего не
 * регистрирует и ни к чему не подключается — только собирает набор функций.
 */

module.exports = function (modelsDB, Utilities) {
    const api = require('./forms/invoices.server')(modelsDB, Utilities);
    return {
        'invoice.postIssue': api.postIssue
    };
};
