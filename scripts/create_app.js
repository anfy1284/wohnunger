const fs = require('fs');
const path = require('path');

/**
 * Скрипт создания нового приложения в фреймворке my-old-space.
 * Использование: node scripts/create_app.js <appName>
 */

const appName = process.argv[2];

if (!appName) {
    console.error('Ошибка: Укажите название приложения. Пример: node scripts/create_app.js myNewApp');
    process.exit(1);
}

// ОПРЕДЕЛЯЕМ ПУТЬ ДЛЯ СОЗДАНИЯ ПРИЛОЖЕНИЯ
// Приоритет: node_modules/my-old-space/apps/ (если мы в корне проекта)
// Или просто apps/ (если мы внутри фреймворка)
const frameworkAppsDir = path.join(__dirname, '..', 'node_modules', 'my-old-space', 'apps');
const localAppsDir = path.join(__dirname, '..', 'apps');

let appsDir;
if (fs.existsSync(frameworkAppsDir)) {
    appsDir = frameworkAppsDir;
} else {
    appsDir = localAppsDir;
}

const appPath = path.join(appsDir, appName);

if (fs.existsSync(appPath)) {
    console.error(`Ошибка: Приложение "${appName}" уже существует по пути ${appPath}`);
    process.exit(1);
}

// Создаем структуру папок
const dirs = [
    '',
    'resources',
    'resources/public',
    'db'
];

dirs.forEach(dir => {
    fs.mkdirSync(path.join(appPath, dir), { recursive: true });
});

// 1. config.json
const config = {
    name: appName,
    title: appName.charAt(0).toUpperCase() + appName.slice(1),
    icon: "default_icon.png"
};
fs.writeFileSync(path.join(appPath, 'config.json'), JSON.stringify(config, null, 4));

// 2. server.js (Минимальный серверный файл)
const serverJs = `
const config = require('./config.json');

function getData(params) {
    return [];
}

function getLayout(params) {
    return [
        {
            type: 'label',
            text: 'Welcome to ' + config.title
        }
    ];
}

async function getLayoutWithData(params) {
    const layout = getLayout(params);
    const data = getData(params);
    return { layout, data };
}

module.exports = {
    getData,
    getLayout,
    getLayoutWithData
};
`;
fs.writeFileSync(path.join(appPath, 'server.js'), serverJs.trim());

// 3. resources/public/client.js (Клиентская часть)
const clientJs = `
/**
 * Клиентская часть приложения ${appName}
 */
console.log('${appName} client loaded');
`;
fs.writeFileSync(path.join(appPath, 'resources', 'public', 'client.js'), clientJs.trim());

// 4. Локальный events_handler.js для приложения
const eventsHandlerContent = `
/**
 * Обработчик событий для приложения ${appName}
 */
export default {
    /**
     * Вызывается при инициализации приложения на сервере.
     */
    onInit: async (context) => {
        console.log('[${appName}] initialized');
    },

    /**
     * Вызывается при запуске приложения на клиенте.
     */
    onAppStart: (app) => {
        console.log('[${appName}] Client app started:', app.name);
    },

    /**
     * Вызывается после создания/миграции таблиц этого приложения.
     */
    onDatabasePostInit: async (context) => {
        console.log('[${appName}] Database post-initialization complete.');
    }
};
`;
fs.writeFileSync(path.join(appPath, 'events_handler.js'), eventsHandlerContent.trim());

// 5. Создание стандартного db.json для приложения
const dbJsonContent = {
    models: [
        {
            name: `${appName.charAt(0).toUpperCase() + appName.slice(1)}Item`,
            tableName: `app_${appName}_items`,
            fields: {
                id: { type: "INTEGER", primaryKey: true, autoIncrement: true },
                name: { type: "STRING", allowNull: false },
                description: { type: "TEXT" }
            }
        }
    ],
    associations: []
};
fs.writeFileSync(path.join(appPath, 'db', 'db.json'), JSON.stringify(dbJsonContent, null, 4));

// 6. Добавление init.js для регистрации приложения во фреймворке
const initJsContent = `
// Регистрация приложения в системе
console.log('[${appName}] Registering application...');
`;
fs.writeFileSync(path.join(appPath, 'init.js'), initJsContent.trim());

console.log(`Приложение "${appName}" успешно создано в ${appPath}`);
