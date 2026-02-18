# Инструкция по развертыванию проекта на фреймворке `my-old-space`

Этот файл содержит все необходимые шаги для быстрой настройки пустого проекта с базой данных SQLite.

## 1. Инициализация проекта и установка зависимостей

Создайте `package.json` и установите фреймворк напрямую из GitHub:

```bash
npm init -y
npm install git+https://github.com/anfy1284/my-old-space.git --save
# Установка обязательных peer-dependencies для SQLite и шифрования:
npm install sqlite3 bcrypt --save
```

## 2. Структура директорий

Создайте необходимые папки в корне проекта:
- `apps/` — для пользовательских модулей/приложений.
- `drive_root/db/` — для хранения файла базы данных.

```bash
mkdir apps
mkdir -p drive_root/db
```

## 3. Конфигурационные файлы (Project Root)

### dbSettings.json
Настройка SQLite (обязательно в корне):
```json
{
    "dialect": "sqlite",
    "storage": "./drive_root/db/database.sqlite",
    "logging": false,
    "define": {
        "timestamps": true
    }
}
```

### server.config.json
Метаданные сервера:
```json
{
    "serverName": "My App Name",
    "port": 3000,
    "appDir": "apps",
    "driveRoot": "drive_root"
}
```

### apps.json
Реестр приложений:
```json
{
    "apps": []
}
```

### apps/apps.json
Реестр приложений внутри папки apps (пустой массив):
```json
[]
```

## 4. Точка входа (index.js)

```javascript
const { start } = require('my-old-space');

start({
  rootPath: __dirname
});
```

## 5. Первый запуск

Запустите приложение для автоматической генерации схемы базы данных и заполнения начальных данных (`defaultValues`):

```bash
node index.js
```

## Особенности фреймворка
- **База данных**: При использовании SQLite файл `database.sqlite` будет создан автоматически при первом запуске.
- **Миграции**: Фреймворк сам проверяет схему и создает таблицы на основе `db.json` определений, найденных в `node_modules/my-old-space` и папке `apps/`.
- **SSE**: Встроенная поддержка Server-Sent Events для мессенджера и уведомлений.
