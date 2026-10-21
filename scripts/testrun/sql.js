'use strict';

/**
 * Запрос к ТЕСТОВОЙ базе для прогона сценариев: проверка «что записалось» фактом, а не
 * по снимку экрана (раздел 0.4а сценариев). На любой базе без «test» в имени — отказ.
 *
 *   node scripts/testrun/sql.js "SELECT number, name FROM clients LIMIT 5"
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'dbSettings.postgres.json'), 'utf8'));
const c = s.postgres || s;
if (!/test/i.test(String(c.database || ''))) {
    console.error(`ОТКАЗ: база «${c.database}» не тестовая.`);
    process.exit(1);
}
const { Sequelize } = require(path.join(ROOT, 'node_modules', 'my-old-space', 'node_modules', 'sequelize'));
const db = new Sequelize(c.database, c.username || c.user, c.password, {
    host: c.host, port: c.port, dialect: 'postgres', logging: false
});

(async () => {
    const sql = process.argv[2];
    if (!sql) { console.error('Нужен SQL-запрос первым аргументом.'); process.exit(1); }
    const [rows] = await db.query(sql);
    console.log(JSON.stringify(rows, null, 1));
    await db.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
