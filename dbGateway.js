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
const log = require('./node_modules/my-old-space/drive_root/log');
const path = require('path');
const fs = require('fs');

/**
 * Зарезервированный session ID для внутренних системных вызовов сервера.
 * Используйте поиск по '__SYS_INTERNAL__' для аудита всех мест, где обходится
 * контроль доступа. Никогда не передавайте это значение с клиента.
 */
const SYSTEM_SESSION_ID = '__SYS_INTERNAL__';

// ─── 0.2 (оптимизация): конфиг читается ОДИН раз, а не на каждую DB-операцию ───
// Раньше каждый dbGateway.execute (а одна отрисовка формы делает их десятки)
// синхронно читал app.config.json с диска (fs.existsSync + readFileSync + JSON.parse),
// блокируя event loop. Теперь — ленивая однократная загрузка в модульную константу.
let _accessConfig = null;
function getAccessConfig() {
    if (_accessConfig) return _accessConfig;
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
            log.error('[project/dbGateway] Error reading app.config.json:', e.message);
        }
    }
    _accessConfig = { requiredFields, excludedTables, excludedSet: new Set(excludedTables) };
    return _accessConfig;
}

// ─── 0.2: кэш контекста доступа пользователя { orgIds, hotelIds } per userId ───
// Раньше КАЖДАЯ операция БД с фильтрами делала до 3 SQL-подзапросов
// (user_organizations × до 2 раз + hotels). На удалённом Postgres (latency
// 5–50мс/запрос) это самый дорогой фактор. Теперь — один запрос user_organizations
// + один hotels на cache-miss, результат живёт TTL_MS. Инвалидация — при записи
// в user_organizations/hotels (см. ниже), чтобы права обновлялись сразу.
const _accessCache = new Map(); // userId → { orgIds, hotelIds, expires }
const ACCESS_TTL_MS = 60 * 1000;
const ACCESS_DEP_TABLES = new Set(['user_organizations', 'hotels']);

async function getAccessContext(userId) {
    const now = Date.now();
    const cached = _accessCache.get(userId);
    if (cached && cached.expires > now) return cached;

    const { Op } = require('sequelize');
    // Один запрос связей пользователя с организациями (был до 3 раз за операцию).
    const userOrgs = await dbGateway.execute({
        operation: 'read',
        table: 'user_organizations',
        where: { userId },
        context: { sessionID: SYSTEM_SESSION_ID }
    });
    const orgIds = userOrgs.map(uo => uo.organizationId);

    // Отели организаций пользователя — один запрос (был отдельным на каждую операцию).
    let hotelIds = [];
    if (orgIds.length > 0) {
        const hotels = await dbGateway.execute({
            operation: 'read',
            table: 'hotels',
            where: { organizationId: { [Op.in]: orgIds } },
            context: { sessionID: SYSTEM_SESSION_ID }
        });
        hotelIds = hotels.map(h => h.UID);
    }

    const ctx = { orgIds, hotelIds, expires: now + ACCESS_TTL_MS };
    _accessCache.set(userId, ctx);
    return ctx;
}

/** Сброс кэша доступа (при изменении прав/состава отелей). */
function invalidateAccessCache() {
    _accessCache.clear();
}

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
                    log.error('[project/dbGateway] Error fetching role:', e.message);
                }
            }
        } catch (e) {
            log.error('[project/dbGateway] Error resolving session:', e.message);
        }
    }

    log.debug(`[dbGateway] table=${table} | userId=${userId} | role=${role} | operation=${operation}`);

    // Инвалидация кэша доступа при изменении прав/состава отелей (любым пользователем).
    if (ACCESS_DEP_TABLES.has(table) && ['create', 'update', 'delete'].includes(operation)) {
        invalidateAccessCache();
    }

    // Пропускаем проверку для админа
    if (role === 'admin') {
        return await next(request);
    }

    // Настройки доступа — из однократно загруженного конфига (см. getAccessConfig).
    const { requiredFields, excludedSet } = getAccessConfig();

    // Если таблица в исключениях (и это не organizations) или это не операция с фильтрами - просто идем дальше
    if ((excludedSet.has(table) && table !== 'organizations') || !['read', 'findOne', 'count', 'update', 'delete'].includes(operation)) {
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

            // Контекст доступа { orgIds, hotelIds } — один кэшируемый расчёт на
            // пользователя вместо до 3 SQL-подзапросов на КАЖДУЮ операцию (0.2).
            const needsContext = (table === 'organizations')
                || (attributes.organizationId)
                || (attributes.hotelId);
            let access = null;
            if (userId && needsContext) {
                access = await getAccessContext(userId);
            }

            // Для таблицы организаций фильтруем по самому UID
            if (table === 'organizations' && userId) {
                filters.push({ UID: { [Op.in]: access.orgIds } });
            }

            // 1. Фильтр по userId
            if (attributes.userId && userId) {
                filters.push({ userId: userId });
            }

            // 2. Фильтр по organizationId (через таблицу связей)
            if (attributes.organizationId && userId) {
                filters.push({ organizationId: { [Op.in]: access.orgIds } });
            }

            // 3. Фильтр по hotelId (через принадлежность отеля организации пользователя)
            if (attributes.hotelId && userId) {
                filters.push({ hotelId: { [Op.in]: access.hotelIds } });
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
                log.debug(`[dbGateway] Applied filters for ${table}:`, JSON.stringify(request.where));
            } else if (!userId) {
                // Если нет userId и есть обязательные поля - блокируем доступ
                request.where = { UID: '__BLOCK_ACCESS__' };
            }
        }
    }

    return await next(request);
});

log.info('[project/dbGateway] App-level middleware registered');

module.exports = dbGateway;