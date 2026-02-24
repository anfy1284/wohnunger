/**
 * dbGateway middleware уровня текущего проекта (app level).
 * 
 * Регистрирует middleware на уровне 'app' — самый верхний уровень.
 * Запрос сначала проходит через этот middleware, затем forms, затем root, затем executor.
 *
 * Здесь можно реализовать:
 *   - бизнес-правила конкретного проекта
 *   - ограничения доступа к определённым таблицам
 *   - логирование / аудит на уровне приложения
 */

const dbGateway = require('./node_modules/my-old-space/drive_root/dbGateway');

// Пустой middleware — пропускает всё дальше без изменений.
// Заглушка для будущей бизнес-логики проекта.
dbGateway.use('app', async function projectAppMiddleware(request, next) {
    // Логируем входящий запрос, чтобы отслеживать, когда middleware вызывается
    try {
        console.log('[project/dbGateway] middleware invoked:', request && request.operation, request && request.table, request && request.context ? JSON.stringify(request.context) : '');
    } catch (e) { /* silent */ }

    try {
        const result = await next(request);
        try { console.log('[project/dbGateway] middleware completed:', request && request.operation, request && request.table); } catch (e) { }
        return result;
    } catch (err) {
        console.error('[project/dbGateway] middleware error:', err && err.message || err);
        throw err;
    }
});

console.log('[project/dbGateway] App-level middleware registered');

module.exports = dbGateway;