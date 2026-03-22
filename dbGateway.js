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
const path = require('path');
const fs = require('fs');

/**
 * Зарезервированный session ID для внутренних системных вызовов сервера.
 * Используйте поиск по '__SYS_INTERNAL__' для аудита всех мест, где обходится
 * контроль доступа. Никогда не передавайте это значение с клиента.
 */
const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';

/**
 * Middleware для контроля доступа на основе обязательных реквизитов (required_access_fields).
 * Накладывает обязательные фильтры на запросы чтения, обновления и удаления.
 * 
 * Принимает из context ТОЛЬКО sessionID. userId и role определяются
 * исключительно на сервере по сессии — никогда не из внешнего контекста.
 */
dbGateway.use('app', async function accessControlMiddleware(request, next) {
    const { operation, table, context = {} } = request;
    const { sessionID } = context;

    // Системные внутренние вызовы — пропускаем без проверки доступа.
    // Ищите '__SYS_INTERNAL__' в коде для аудита всех мест обхода контроля доступа.
    if (sessionID === SYSTEM_SESSION_ID) {
        return await next(request);
    }

    // Резолвим пользователя только через сессию — никогда не доверяем userId/role из контекста
    let userId = null;
    let role = null;
    if (sessionID) {
        try {
            const globalRoot = require('./node_modules/my-old-space/drive_root/globalServerContext');
            const user = await globalRoot.getUserBySessionID(sessionID);
            if (user) {
                userId = user.UID;
                try {
                    const globalForms = require('./node_modules/my-old-space/drive_forms/globalServerContext');
                    role = await globalForms.getUserAccessRole({ UID: userId });
                } catch (e) {
                    console.error('[project/dbGateway] Error fetching role:', e.message);
                }
            }
        } catch (e) {
            console.error('[project/dbGateway] Error resolving session:', e.message);
        }
    }

    console.log(`[dbGateway DEBUG] table=${table} | userId=${userId} | role=${role} | operation=${operation}`);

    // Пропускаем проверку для админа
    if (role === 'admin') {
        return await next(request);
    }

    // Загружаем настройки из app.config.json
    const projectRoot = process.env.PROJECT_ROOT || __dirname;
    const configPath = path.join(projectRoot, 'app.config.json');
    let requiredFields = [];
    let excludedTables = [];

    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            requiredFields = config.required_access_fields || [];
            excludedTables = config.excluded_tables || [];
        } catch (e) {
            console.error('[project/dbGateway] Error reading app.config.json:', e.message);
        }
    }

    // Если таблица в исключениях (и это не organizations) или это не операция с фильтрами - просто идем дальше
    if ((excludedTables.includes(table) && table !== 'organizations') || !['read', 'findOne', 'count', 'update', 'delete'].includes(operation)) {
        return await next(request);
    }

    // Получаем модель для проверки наличия полей
    const globalCtx = require('./node_modules/my-old-space/drive_root/globalServerContext');
    const modelName = globalCtx.getModelNameForTable(table);
    if (!modelName) return await next(request);
    
    const Model = globalCtx.modelsDB[modelName];

    if (Model && Model.rawAttributes) {
        const attributes = Model.rawAttributes;
        const availableFields = requiredFields.filter(f => attributes[f]);

        if (availableFields.length > 0 || table === 'organizations') {
            if (!request.where) request.where = {};
            const { Op } = require('sequelize');
            const filters = [];

            // Для таблицы организаций фильтруем по самому UID
            if (table === 'organizations' && userId) {
                const userOrgs = await dbGateway.execute({
                    operation: 'read',
                    table: 'user_organizations',
                    where: { userId: userId },
                    context: { sessionID: SYSTEM_SESSION_ID }
                });
                const orgIds = userOrgs.map(uo => uo.organizationId);
                console.log(`[dbGateway DEBUG] Allowed orgIds for ${userId}:`, orgIds);
                filters.push({ UID: { [Op.in]: orgIds } });
            }

            // 1. Фильтр по userId
            if (attributes.userId && userId) {
                filters.push({ userId: userId });
            }

            // 2. Фильтр по organizationId (через таблицу связей)
            if (attributes.organizationId && userId) {
                const userOrgs = await dbGateway.execute({
                    operation: 'read',
                    table: 'user_organizations',
                    where: { userId: userId },
                    context: { sessionID: SYSTEM_SESSION_ID }
                });
                const orgIds = userOrgs.map(uo => uo.organizationId);
                filters.push({ organizationId: { [Op.in]: orgIds } });
            }

            // 3. Фильтр по hotelId (через принадлежность отеля организации пользователя)
            if (attributes.hotelId && userId) {
                const userOrgs = await dbGateway.execute({
                    operation: 'read',
                    table: 'user_organizations',
                    where: { userId: userId },
                    context: { sessionID: SYSTEM_SESSION_ID }
                });
                const orgIds = userOrgs.map(uo => uo.organizationId);

                const hotels = await dbGateway.execute({
                    operation: 'read',
                    table: 'hotels',
                    where: { organizationId: { [Op.in]: orgIds } },
                    context: { sessionID: SYSTEM_SESSION_ID }
                });
                const hotelIds = hotels.map(h => h.UID);
                console.log(`[dbGateway DEBUG] Allowed hotelIds for ${userId} via orgIds(${orgIds}):`, hotelIds);
                filters.push({ hotelId: { [Op.in]: hotelIds } });
            }

            // Накладываем фильтры через OR (доступ, если выполняется хотя бы одно условие)
            if (filters.length > 0) {
                const existingWhere = request.where;
                if (Object.keys(existingWhere).length > 0) {
                    request.where = {
                        [Op.and]: [
                            existingWhere,
                            { [Op.or]: filters }
                        ]
                    };
                } else {
                    request.where = { [Op.or]: filters };
                }
                console.log(`[dbGateway DEBUG] Applied filters for ${table}:`, JSON.stringify(request.where));
            } else if (!userId) {
                // Если нет userId и есть обязательные поля - блокируем доступ
                request.where = { UID: '__BLOCK_ACCESS__' };
            }
        }
    }

    return await next(request);
});

console.log('[project/dbGateway] App-level middleware registered');

module.exports = dbGateway;