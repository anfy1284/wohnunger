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

## Иконки

### Правило: каждый UI-элемент должен иметь иконку

При создании **любого** нового UI-объекта (кнопка, пункт меню, колонка таблицы и т.д.)
**обязательно** назначать ему иконку из каталога.

### Каталог иконок

Полный список доступных иконок находится в файле:
```
D:\wohnunger_icons\ICONS_CATALOG.txt
```

### Как использовать иконку

Иконки доступны через два приложения:

| Коллекция | Приложение | URL |
|-----------|------------|-----|
| general (системные) | `general_icons` (фреймворк) | `/apps/general_icons/resources/public/16x16/<id>.png` или `/apps/general_icons/resources/public/32x32/<id>.png` |
| booking (прикладные) | `booking_icons` (проект) | `/apps/booking_icons/resources/public/16x16/<id>.png` или `/apps/booking_icons/resources/public/32x32/<id>.png` |

Пример использования в форме (`init.js`):
```javascript
// Кнопка с иконкой
{ id: 'btnSave', type: 'button', text: 'Сохранить', icon: '/apps/general_icons/resources/public/16x16/save.png' }

// Кнопка прикладного решения
{ id: 'btnCalc', type: 'button', text: 'Рассчитать', icon: '/apps/booking_icons/resources/public/16x16/calculate.png' }
```

### Как добавить новую иконку

1. Создать файл `D:\wohnunger_icons\scripts\icons/<коллекция>/<id>.py` по образцу существующих
2. Запустить: `python scripts/generate_all.py`
3. Обновить `ICONS_CATALOG.txt`
4. Задеплоить: `python scripts/deploy.py`
