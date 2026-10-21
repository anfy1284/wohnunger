// Вызовы сервера тестовым сотрудником — честный вход и тот же HTTP-путь, что у браузера
// (АРХИТЕКТУРА §78.9). Нужен работающий сервер на :3000. Только тестовая база.
//   node scripts/testrun/api.js appcall <app> <method> '<json>'   — /app/call
//   node scripts/testrun/api.js wait                             — ждать пустую очередь проведения
//   node scripts/testrun/api.js adduser            — завести сотрудника probe_update в организации Seiler (пароль → tmp/testrun_api_creds.json)
//   node scripts/testrun/api.js postMany <table>   — групповое проведение всех непроведённых документов таблицы
//   node scripts/testrun/api.js call <uid> <fn> '<json>'   — /server-call
const path = require('path'), fs = require('fs');
const ROOT = 'D:/wohnunger', FW = path.join(ROOT, 'node_modules/my-old-space');
const { Sequelize, QueryTypes } = require(path.join(ROOT, 'node_modules/sequelize'));
const { hashPassword, generateUID } = require(path.join(FW, 'drive_root/db/utilites'));
const s = require(path.join(ROOT, 'dbSettings.postgres.json'));
if (s.database !== 'wohnungerTest') throw new Error('только тестовая база');
const db = new Sequelize(s.database, s.username, s.password, { host: s.host, port: s.port, dialect: 'postgres', logging: false });
const CREDS = path.join(ROOT, 'tmp', 'testrun_api_creds.json');   // tmp/ не в git
const BASE = 'http://localhost:3000';
const q = (sql, r) => db.query(sql, { replacements: r, type: QueryTypes.SELECT });

async function adduser() {
    const [org] = await q(`SELECT "UID" FROM organizations WHERE name LIKE 'Gästehaus%' LIMIT 1`);
    const login = 'probe_update';
    const ex = await q(`SELECT "UID" FROM users WHERE name = :l`, { l: login });
    if (ex.length) { console.log('уже есть'); return; }
    const password = require('crypto').randomBytes(9).toString('base64url');
    const id = generateUID('users'), now = new Date();
    await db.query(`INSERT INTO users ("UID", name, presentation, email, "isGuest", language, password_hash,
        "mustChangePassword", disabled, "organizationId", "createdAt", "updatedAt")
        VALUES (:id, :login, 'Probe Update', '', false, 'de', :hash, false, false, :org, :now, :now)`,
        { replacements: { id, login, hash: await hashPassword(password), org: org.UID, now } });
    await db.query(`INSERT INTO user_systems ("UID", name, "roleId", "systemId", "userId", "createdAt", "updatedAt")
        VALUES (:i, '', '000000000-sys_forms-0005', '000000000-sys_forms-0001', :u, :now, :now)`,
        { replacements: { i: generateUID('usys'), u: id, now } });
    await db.query(`INSERT INTO user_organizations ("UID", name, "organizationId", "userId", "createdAt", "updatedAt")
        VALUES (:i, '', :org, :u, :now, :now)`, { replacements: { i: generateUID('uo'), org: org.UID, u: id, now } });
    fs.writeFileSync(CREDS, JSON.stringify({ login, password }));
    console.log('сотрудник заведён:', login);
}

let cookie = '';
async function http(url, body) {
    const r = await fetch(BASE + url, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}
async function login() {
    const c = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
    await http('/');
    const r = await http('/server-call', { uid: 'login.actions', fn: 'login', fnParams: { username: c.login, password: c.password } });
    if (!r || r.error || (r.result && r.result.error)) throw new Error('вход: ' + JSON.stringify(r));
}
async function call(uid, fn, params) { return http('/server-call', { uid, fn, fnParams: params }); }

async function waitQueue(maxSec = 600) {
    for (let i = 0; i < maxSec; i++) {
        const [r] = await q(`SELECT count(*)::int n FROM posting_queue WHERE coalesce("lastError", '') = ''`).catch(() => [{ n: -1 }]);
        if (!r || r.n === 0) return i;
        await new Promise(res => setTimeout(res, 1000));
    }
    return -1;
}

(async () => {
    const [cmd, a, b, c] = process.argv.slice(2);
    if (cmd === 'adduser') await adduser();
    else if (cmd === 'postMany') {
        const rows = await q(`SELECT "UID" FROM "${a}" WHERE "postingState" <> 'posted' AND "deletionMark" = false ORDER BY date, seq`);
        await login();
        const r = await call('document.actions', 'postMany', { table: a, uids: rows.map(x => x.UID) });
        console.log('postMany', JSON.stringify(r).slice(0, 300));
        console.log('очередь пуста через', await waitQueue(), 'с');
    } else if (cmd === 'call') {
        await login();
        console.log(JSON.stringify(await call(a, b, JSON.parse(c || '{}')), null, 1).slice(0, 3000));
    } else if (cmd === 'appcall') {
        await login();
        console.log(JSON.stringify(await http('/app/call', { app: a, method: b, params: JSON.parse(c || '{}') }), null, 1).slice(0, 3000));
    } else if (cmd === 'wait') console.log('очередь пуста через', await waitQueue(), 'с');
    await db.close();
})().catch(e => { console.error(e.message || e); process.exitCode = 1; db.close(); });
