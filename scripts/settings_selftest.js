'use strict';

/**
 * settings_selftest — самопроверка механизма настроек приложений.
 *
 * Запуск:  node scripts/settings_selftest.js
 *
 * Работает на отдельной базе SQLite в памяти и на тестовых объявлениях
 * (`scripts/settings_selftest_fixture/`): рабочую базу не трогает и подключения к ней
 * не открывает — модели рантайма подменяются в require-кэше. Проверяются реестр
 * объявлений, засев дефолтов, цепочка «значение → дефолт → объявление», служебные
 * колонки RLS, проверка ссылок и громкие ошибки на ошибки программиста.
 *
 * Тестового набора в проекте нет; этот скрипт — такая же разовая диагностика, как
 * scripts/restore_*_selftest.js.
 */

const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');

const FW = path.join(__dirname, '..', 'node_modules', 'my-old-space');
const TEST_PROJECT = path.join(__dirname, 'settings_selftest_fixture');
process.env.PROJECT_ROOT = TEST_PROJECT;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

const registry = require(FW + '/drive_root/settings/registry');
const { parseData } = require(FW + '/drive_root/settings/types');
const { seedDefaults } = require(FW + '/drive_root/settings/seed');

let failed = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ' (ждали ' + JSON.stringify(expected) + ')'}`);
}
async function expectThrow(name, fn) {
    try { await fn(); failed++; console.log(`FAIL ${name}: ошибки не было`); }
    catch (e) { console.log(`OK   ${name}: ${e.message}`); }
}

(async () => {
    const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });

    const SettingsValues = sequelize.define('SettingsValues', {
        UID: { type: DataTypes.STRING, primaryKey: true, defaultValue: () => 'uid-' + Math.random().toString(36).slice(2) },
        scopeTable: { type: DataTypes.STRING, allowNull: false },
        scopeId: { type: DataTypes.STRING, allowNull: false },
        appName: { type: DataTypes.STRING, allowNull: false },
        kind: { type: DataTypes.STRING, allowNull: false, defaultValue: 'setting' },
        data: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
        userId: { type: DataTypes.STRING, allowNull: true },
        organizationId: { type: DataTypes.STRING, allowNull: true }
    }, { tableName: 'settings_values', timestamps: true });

    const Users = sequelize.define('Users', {
        UID: { type: DataTypes.STRING, primaryKey: true }, name: DataTypes.STRING
    }, { tableName: 'users', timestamps: false });
    const Hotels = sequelize.define('Hotels', {
        UID: { type: DataTypes.STRING, primaryKey: true }, name: DataTypes.STRING, organizationId: DataTypes.STRING
    }, { tableName: 'hotels', timestamps: false });
    const Languages = sequelize.define('Languages', {
        UID: { type: DataTypes.STRING, primaryKey: true }, name: DataTypes.STRING
    }, { tableName: 'languages', timestamps: false });

    await sequelize.sync();
    await Users.create({ UID: 'user-1', name: 'Anna' });
    await Hotels.create({ UID: 'hotel-1', name: 'Haus Anna', organizationId: 'org-7' });
    await Languages.create({ UID: 'lang-de', name: 'Deutsch' });

    // Реестр по тестовому проекту
    const r = registry.load(TEST_PROJECT);
    registry.validateTables(['users', 'hotels', 'languages']);
    // Приложения фреймворка со своими settings.json тоже попадают в реестр — проверяем
    // не их число, а что тестовые объявления разобраны.
    check('реестр собрал тестовое приложение', registry.getSettings('demo').map(d => d.key).sort(),
        ['checkInTime', 'hiddenLimit', 'maxRows']);

    // Засев дефолтов
    const seeded = await seedDefaults(sequelize, TEST_PROJECT);
    check('засеяно значений', seeded.added >= 3, true);
    const defRow = await SettingsValues.findOne({ where: { scopeTable: '__default', appName: 'demo' }, raw: true });
    check('строка дефолтов demo', parseData(defRow.data).checkInTime, '15:00');

    // Повторный засев ничего не добавляет и не затирает правку
    await SettingsValues.update({ data: Object.assign({}, parseData(defRow.data), { checkInTime: '14:00' }) }, { where: { UID: defRow.UID } });
    const again = await seedDefaults(sequelize, TEST_PROJECT);
    check('повторный засев не добавляет', again.added, 0);
    const defRow2 = await SettingsValues.findOne({ where: { scopeTable: '__default', appName: 'demo' }, raw: true });
    check('правка администратора уцелела', parseData(defRow2.data).checkInTime, '14:00');

    // Подмена моделей рантайма для settings/index.js
    const gscPath = require.resolve(FW + '/drive_root/globalServerContext.js');
    require.cache[gscPath] = { id: gscPath, filename: gscPath, loaded: true, exports: {
        modelsDB: { SettingsValues, Users, Hotels, Languages }
    } };
    const settings = require(FW + '/drive_root/settings');

    // Чтение: значения нет → дефолт из строки дефолтов
    check('гостиница: дефолт', await settings.getRecordSetting('hotel', 'hotel-1', 'demo', 'checkInTime'), '14:00');

    // Запись и повторное чтение + служебная колонка организации
    await settings.setRecordSetting('hotel', 'hotel-1', 'demo', 'checkInTime', '11:30');
    check('гостиница: своё значение', await settings.getRecordSetting('hotel', 'hotel-1', 'demo', 'checkInTime'), '11:30');
    const hotelRow = await SettingsValues.findOne({ where: { scopeTable: 'hotels', scopeId: 'hotel-1' }, raw: true });
    check('RLS-колонка organizationId заполнена', hotelRow.organizationId, 'org-7');
    check('RLS-колонка userId пуста', hotelRow.userId, null);

    // Очистка значения — снова дефолт
    await settings.clearSetting('hotel', 'hotel-1', 'demo', 'checkInTime');
    check('после очистки — дефолт', await settings.getRecordSetting('hotel', 'hotel-1', 'demo', 'checkInTime'), '14:00');

    // Правка дефолта администратором действует на записи без своего значения
    await settings.setDefault('demo', 'checkInTime', '16:00');
    check('новый дефолт виден', await settings.getRecordSetting('hotel', 'hotel-1', 'demo', 'checkInTime'), '16:00');

    // Системный уровень
    check('система: дефолт', await settings.getSystemSetting('demo', 'maxRows'), 5000);
    await settings.setSystemSetting('demo', 'maxRows', 250);
    check('система: своё значение', await settings.getSystemSetting('demo', 'maxRows'), 250);
    const sysRow = await SettingsValues.findOne({ where: { scopeTable: '__system' }, raw: true });
    check('системная строка без владельца', [sysRow.userId, sysRow.organizationId], [null, null]);

    // Пользовательский уровень + ссылка на справочник
    await settings.setUserSetting('user-1', 'core', 'language', 'lang-de');
    check('пользователь: язык', await settings.getUserSetting('user-1', 'core', 'language'), 'lang-de');
    const userRow = await SettingsValues.findOne({ where: { scopeTable: 'users' }, raw: true });
    check('RLS-колонка userId заполнена', userRow.userId, 'user-1');

    // Битая ссылка при чтении → дефолт и предупреждение
    await Languages.destroy({ where: { UID: 'lang-de' } });
    check('удалённая ссылка → дефолт', await settings.getUserSetting('user-1', 'core', 'language'), null);

    // Пустая строка в базе — это «не задано»: работает значение по умолчанию.
    // (Так приезжают значения из переноса старых настроек.)
    await SettingsValues.update({ data: { checkInTime: '' } },
        { where: { scopeTable: 'hotels', scopeId: 'hotel-1', appName: 'demo' } });
    check('пустая строка = не задано', await settings.getRecordSetting('hotel', 'hotel-1', 'demo', 'checkInTime'), '16:00');
    await SettingsValues.destroy({ where: { scopeTable: 'hotels', scopeId: 'hotel-1', appName: 'demo' } });

    // Набор настроек уровня одним вызовом
    check('набор настроек гостиницы', await settings.getAppSettings('hotel', 'hotel-1', 'demo'), { checkInTime: '16:00' });

    // Ошибки программиста — громкие
    await expectThrow('незаявленная настройка', () => settings.getUserSetting('user-1', 'demo', 'nope'));
    await expectThrow('чужой уровень', () => settings.getUserSetting('user-1', 'demo', 'checkInTime'));
    await expectThrow('значение не из списка', () => settings.setSystemSetting('demo', 'maxRows', 'много'));
    await expectThrow('ссылка на несуществующую запись', () => settings.setUserSetting('user-1', 'core', 'language', 'lang-xx'));


    // ── Часть 2: форма «Настройки» ───────────────────────────────────────────
    // Подменяем то, что форма берёт из ядра: модели, RLS-шлюз и переводы.
    const gwPath = require.resolve(FW + '/drive_root/dbGateway.js');
    const SESSIONS = {
        'sess-user':  { role: 'user',  userId: 'user-1', allowed: { users: ['user-1'], hotels: ['hotel-1'] } },
        'sess-admin': { role: 'admin', userId: 'user-9', allowed: '*' }
    };
    const TABLES = { users: Users, hotels: Hotels, languages: Languages };
    require.cache[gwPath] = { id: gwPath, filename: gwPath, loaded: true, exports: {
        // Упрощённый RLS: администратор видит всё, пользователь — перечисленное.
        execute: async ({ table, where, context }) => {
            const model = TABLES[table];
            if (!model) return [];
            const rows = await model.findAll({ where: where || {}, raw: true });
            const s = SESSIONS[context && context.sessionID];
            if (!s || s.allowed === '*') return rows;
            const allowed = s.allowed[table] || [];
            return rows.filter(r => allowed.indexOf(r.UID) >= 0);
        }
    } };
    const fwGscPath = require.resolve(FW + '/drive_forms/globalServerContext.js');
    require.cache[fwGscPath] = { id: fwGscPath, filename: fwGscPath, loaded: true, exports: {
        tForSession: async (key) => key,
        invalidateSessionContext: () => {}
    } };
    require.cache[gscPath].exports.getUserBySessionID = async (sessionID) => {
        const s = SESSIONS[sessionID];
        return s ? { UID: s.userId, name: s.userId } : null;
    };

    const formModule = require(FW + '/apps/settings/forms/app_settings.server.js');
    const form = formModule({ UserSettingsDefaults: null }, {});
    const asUser  = { sessionID: 'sess-user',  role: 'user'  };
    const asAdmin = { sessionID: 'sess-admin', role: 'admin' };
    const F = formModule.fieldName;

    // Лейаут: скрытые настройки и админские уровни — только администратору
    const admLayout = JSON.stringify(formModule.buildLayout(true));
    const usrLayout = JSON.stringify(formModule.buildLayout(false));
    check('админу виден уровень «система»', admLayout.indexOf('"system"') >= 0, true);
    check('пользователю уровень «система» не виден', usrLayout.indexOf('"system"') >= 0, false);
    check('админу видна скрытая настройка', admLayout.indexOf(F('demo', 'hiddenLimit')) >= 0, true);
    check('пользователю скрытая настройка не видна', usrLayout.indexOf(F('demo', 'hiddenLimit')) >= 0, false);
    check('селектор пользователя заблокирован не админу', usrLayout.indexOf('"readOnly":true') >= 0, true);

    // Открытие формы обычным пользователем
    const opened = await form.onLoadData({ params: {} }, asUser);
    const byName = {};
    for (const d of opened.data) byName[d.name] = d;
    check('уровень по умолчанию', byName['__scope'].value, 'user');
    check('запись по умолчанию — сам пользователь', byName['__rec_user'].value, 'user-1');

    // Чужие настройки: обычному нельзя, администратору можно
    const alien = await form.loadForScope({ scope: 'user', recordId: 'user-9' }, asUser);
    check('чужой пользователь недоступен', alien.reason, 'not_own_user');
    await Users.create({ UID: 'user-9', name: 'Admin' });
    const alienOk = await form.loadForScope({ scope: 'user', recordId: 'user-9' }, asAdmin);
    check('администратору чужой пользователь доступен', !alienOk.error, true);

    // Запись чужих настроек обычным пользователем — отказ
    const denied = await form.onSave({ changes: {
        __scope: 'user', __rec_user: 'user-9', [F('core', 'language')]: 'lang-de'
    } }, asUser);
    check('запись чужих настроек отклонена', denied.ok, false);

    // Своя запись проходит. Язык в части 1 уже был 'lang-de' (справочную запись там же
    // удаляли) — ставим ДРУГОЙ, иначе «сменился» было бы неправдой.
    await Languages.create({ UID: 'lang-de', name: 'Deutsch' });
    await Languages.create({ UID: 'lang-en', name: 'English' });
    const saved = await form.onSave({ changes: {
        __scope: 'user', __rec_user: 'user-1', [F('core', 'language')]: 'lang-en'
    } }, asUser);
    check('свои настройки сохранены', saved.ok, true);
    check('смена своего языка требует перезагрузки', saved.languageChanged, true);
    check('значение записалось', await settings.getUserSetting('user-1', 'core', 'language'), 'lang-en');

    // Тот же язык записан повторно — перезагружать страницу незачем
    const again2 = await form.onSave({ changes: {
        __scope: 'user', __rec_user: 'user-1', [F('core', 'language')]: 'lang-en'
    } }, asUser);
    check('повтор того же языка перезагрузки не требует', again2.languageChanged, false);

    // Админ меняет язык ЧУЖОМУ пользователю — его собственную страницу не трогаем
    const alienLang = await form.onSave({ changes: {
        __scope: 'user', __rec_user: 'user-1', [F('core', 'language')]: 'lang-de'
    } }, asAdmin);
    check('смена чужого языка страницу админа не перезагружает', alienLang.languageChanged, false);

    // Скрытую настройку обычный пользователь не запишет, даже прислав поле
    await form.onSave({ changes: { __scope: 'user', __rec_user: 'user-1', [F('demo', 'hiddenLimit')]: 777 } }, asUser);
    check('скрытая настройка не поддалась', await settings.getUserSetting('user-1', 'demo', 'hiddenLimit'), 10);
    await form.onSave({ changes: { __scope: 'user', __rec_user: 'user-1', [F('demo', 'hiddenLimit')]: 777 } }, asAdmin);
    check('администратор скрытую настройку записал', await settings.getUserSetting('user-1', 'demo', 'hiddenLimit'), 777);

    // Уровень записи по RLS: своя гостиница видна, чужая — нет
    await Hotels.create({ UID: 'hotel-2', name: 'Чужой дом', organizationId: 'org-8' });
    const foreignHotel = await form.loadForScope({ scope: 'hotel', recordId: 'hotel-2' }, asUser);
    check('чужая гостиница не отдаётся', foreignHotel.reason, 'record_not_visible');
    const ownHotel = await form.loadForScope({ scope: 'hotel', recordId: 'hotel-1' }, asUser);
    check('своя гостиница отдаётся', !ownHotel.error, true);

    // Уровень дефолтов — только администратору
    const defDenied = await form.onSave({ changes: { __scope: 'default', [F('demo', 'checkInTime')]: '09:00' } }, asUser);
    check('дефолты обычному пользователю не поддались', defDenied.ok, false);
    const defOk = await form.onSave({ changes: { __scope: 'default', [F('demo', 'checkInTime')]: '09:00' } }, asAdmin);
    check('администратор правит дефолты', defOk.ok, true);
    check('новый дефолт применился к гостинице', await settings.getRecordSetting('hotel', 'hotel-1', 'demo', 'checkInTime'), '09:00');

    await sequelize.close();
    console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВсё сошлось');
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('СБОЙ ТЕСТА:', e); process.exit(2); });
