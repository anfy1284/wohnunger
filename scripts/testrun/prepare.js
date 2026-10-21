'use strict';

/**
 * ПОДГОТОВКА ПРОГОНА СЦЕНАРИЕВ (15.10.2026) — то, что может сделать только администратор.
 *
 * Решение владельца: каждый прогон идёт в НОВОЙ, ПУСТОЙ организации с одним отелем и
 * одним сотрудником. Сотрудник сам заводит всё, что ему доступно (реквизиты организации,
 * номера, услуги, сезоны, цены, места оплаты, настройки), и потом «работает». Несколько
 * отелей в одной организации и одновременная работа разных организаций — пока не
 * проверяем.
 *
 * Скрипт создаёт:
 *   - организацию (только название — остальные реквизиты заполняет сотрудник);
 *   - отель этой организации;
 *   - пользователя с ролью `user`, привязанного к организации, с немецким интерфейсом.
 *
 * После прогона НИЧЕГО НЕ УДАЛЯЕТСЯ: владелец открывает стенд под этим пользователем и
 * смотрит. Имя и пароль пишутся в файл tmp/ПРОГОН_СЦЕНАРИЕВ_<дата>_доступ.md.
 *
 * Только тестовая база — иначе отказ.
 *
 * Запуск: node scripts/testrun/prepare.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const FW = path.join(ROOT, 'node_modules', 'my-old-space');
const { Sequelize } = require(path.join(FW, 'node_modules', 'sequelize'));
const { hashPassword, generateUID } = require(path.join(FW, 'drive_root', 'db', 'utilites'));

const ROLE_USER = '000000000-sys_forms-0005';
const SYSTEM = '000000000-sys_forms-0001';
const LANG_DE = '000000000-lang-0003';

// Правдоподобные названия: данные прогона ничем не помечаются (решение владельца).
const HOUSES = [
    'Pension Alpenblick', 'Gasthof Zur Linde', 'Ferienhof Sonnenhang', 'Landhaus Bergwiese',
    'Gästehaus Am Bach', 'Pension Edelweiß', 'Ferienwohnungen Seeblick', 'Haus Waldesruh',
    'Gasthof Hirschen', 'Pension Talblick', 'Ferienhof Lindenhof', 'Gästehaus Kirchberg'
];
const PEOPLE = ['Anna Hofer', 'Maria Gruber', 'Thomas Wagner', 'Sabine Brandl', 'Josef Huber', 'Katrin Maier'];

function randomPassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(12);
    let s = '';
    for (const b of bytes) s += alphabet[b % alphabet.length];
    return s;
}

async function main() {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'dbSettings.postgres.json'), 'utf8'));
    const c = s.postgres || s;
    if (!/test/i.test(String(c.database || ''))) {
        console.error(`ОТКАЗ: база «${c.database}» не тестовая.`);
        process.exit(1);
    }
    const db = new Sequelize(c.database, c.username || c.user, c.password, {
        host: c.host, port: c.port, dialect: 'postgres', logging: false
    });
    const q = (sql, replacements) => db.query(sql, { replacements, type: Sequelize.QueryTypes.SELECT });
    const exec = (sql, replacements, t) => db.query(sql, { replacements, transaction: t });

    // Название — первое ещё не занятое из списка.
    const usedOrgs = new Set((await q('SELECT name FROM organizations')).map(r => r.name));
    const house = HOUSES.find(h => !usedOrgs.has(h)) || `${HOUSES[0]} ${usedOrgs.size + 1}`;
    const person = PEOPLE[usedOrgs.size % PEOPLE.length];

    // Логин — по дате; при повторе в тот же день — с буквой.
    const d = new Date();
    const stamp = String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const usedLogins = new Set((await q('SELECT name FROM users')).map(r => r.name));
    let login = 'pruefer' + stamp;
    for (let i = 0; usedLogins.has(login); i++) login = 'pruefer' + stamp + String.fromCharCode(98 + i);
    const password = randomPassword();

    const nextNumber = async (table) => {
        const rows = await q(`SELECT number FROM "${table}"`);
        let max = 0, width = 5;
        for (const r of rows) {
            const m = /(\d+)$/.exec(String(r.number || ''));
            if (m) { max = Math.max(max, parseInt(m[1], 10)); width = Math.max(width, m[1].length); }
        }
        return String(max + 1).padStart(width, '0');
    };

    const now = new Date();
    const orgId = generateUID('organization');
    const hotelId = generateUID('hotel');
    const userId = generateUID('user');

    await db.transaction(async (t) => {
        await exec(`INSERT INTO organizations ("UID", name, number, "isActive", "deletionMark", "createdAt", "updatedAt")
                    VALUES (:id, :name, :num, true, false, :now, :now)`,
            { id: orgId, name: house, num: await nextNumber('organizations'), now }, t);
        await exec(`INSERT INTO hotels ("UID", name, number, "organizationId", "deletionMark", "createdAt", "updatedAt")
                    VALUES (:id, :name, :num, :org, false, :now, :now)`,
            { id: hotelId, name: house, num: await nextNumber('hotels'), org: orgId, now }, t);
        await exec(`INSERT INTO users ("UID", name, presentation, email, "isGuest", language, password_hash,
                        "mustChangePassword", disabled, "organizationId", "createdAt", "updatedAt")
                    VALUES (:id, :login, :pres, '', false, 'de', :hash, false, false, :org, :now, :now)`,
            { id: userId, login, pres: person, hash: await hashPassword(password), org: orgId, now }, t);
        await exec(`INSERT INTO user_systems ("UID", name, "roleId", "systemId", "userId", "createdAt", "updatedAt")
                    VALUES (:id, '', :role, :sys, :user, :now, :now)`,
            { id: generateUID('usys'), role: ROLE_USER, sys: SYSTEM, user: userId, now }, t);
        await exec(`INSERT INTO user_organizations ("UID", name, "organizationId", "userId", "createdAt", "updatedAt")
                    VALUES (:id, '', :org, :user, :now, :now)`,
            { id: generateUID('uo'), org: orgId, user: userId, now }, t);
        // Язык ДО входа (форма входа, после «Abmelden») — умолчание настройки
        // core.language. Задаёт его администратор; ставим немецкий, только если пусто.
        await exec(`UPDATE settings_values
                       SET data = (data::jsonb || jsonb_build_object('language', :lang::text))::json
                     WHERE "scopeTable" = '__default' AND "appName" = 'core' AND kind = 'setting'
                       AND COALESCE(data->>'language', '') = ''`,
            { lang: LANG_DE }, t);
        // Язык интерфейса — немецкий (правило прогонов). Настройка уровня «пользователь».
        await exec(`INSERT INTO settings_values ("UID", "appName", data, kind, name, "organizationId", "scopeId",
                        "scopeTable", "userId", "createdAt", "updatedAt")
                    VALUES (:id, 'core', :data, 'setting', '', '', :user, 'users', :user, :now, :now)`,
            { id: generateUID('lang'), data: JSON.stringify({ language: LANG_DE }), user: userId, now }, t);
    });
    await db.close();

    const date = now.toISOString().slice(0, 10);
    const file = path.join(ROOT, 'tmp', `ПРОГОН_СЦЕНАРИЕВ_${date}_доступ.md`);
    const text = [
        `# Доступ к прогону сценариев ${date}`,
        '',
        `- Адрес: http://localhost:3000`,
        `- Пользователь: \`${login}\` (${person}, роль user, язык Deutsch)`,
        `- Пароль: \`${password}\``,
        `- Организация: ${house} (UID ${orgId})`,
        `- Отель: ${house} (UID ${hotelId})`,
        '',
        'Тестовая база wohnungerTest, только локально. После прогона ничего не удаляется.',
        ''
    ].join('\n');
    fs.appendFileSync(file, text + '\n');
    console.log(text);
    console.log('Записано: ' + path.relative(ROOT, file));
}

main().catch(e => { console.error(e); process.exit(1); });
