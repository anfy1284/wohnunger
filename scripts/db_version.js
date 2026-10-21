// Какой код последним запускал эту базу и какие разовые скрипты на ней выполнены.
// Только читает.
//
//   node scripts/db_version.js                                  — локальная база (dbSettings.postgres.json)
//   node scripts/db_version.js --settings _dbSettings.postgres.json --ssl   — другая база
//
// Версия кода пишется в db_versions при каждом старте с новым кодом
// (my-old-space/drive_root/buildInfo.js), скрипты — в db_scripts
// (my-old-space/drive_root/db/scriptLog.js). Базы, которые последним запускал код
// старше 16.10.2026, версии не знают: appVersion у них пустой или «0.1.0».
const path = require('path');
const { Sequelize, QueryTypes } = require('sequelize');

const argv = process.argv.slice(2);
const at = argv.indexOf('--settings');
const settingsFile = path.resolve(__dirname, '..', at >= 0 ? argv[at + 1] : 'dbSettings.postgres.json');
const s = require(settingsFile);

const sequelize = new Sequelize(s.database, s.username, s.password, {
    host: s.host, port: s.port, dialect: s.dialect, logging: false,
    dialectOptions: argv.includes('--ssl') ? { ssl: { require: true, rejectUnauthorized: false } } : {}
});

(async () => {
    const q = (sql) => sequelize.query(sql, { type: QueryTypes.SELECT }).catch(e => { console.log('  (' + e.message + ')'); return []; });
    console.log(`База: ${s.database} @ ${s.host}\n`);
    console.log('Версии (db_versions, последние 10):');
    const vers = await q(`SELECT "number","createdAt","appVersion","frameworkVersion","origin",
        left("configHash", 19) AS "configHash" FROM db_versions ORDER BY "createdAt" DESC LIMIT 10`);
    for (const v of vers) {
        console.log(`  ${v.number}  ${new Date(v.createdAt).toISOString().slice(0, 16)}  app=${v.appVersion || '—'}  fw=${v.frameworkVersion || '—'}  ${v.origin}  ${v.configHash}`);
    }
    console.log('\nВыполненные скрипты (db_scripts):');
    const exists = await q(`SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'db_scripts'`);
    if (!exists.length) {
        console.log('  таблицы нет — на этой базе ни один скрипт ещё не записывал себя');
    } else {
        const rows = await q(`SELECT "scriptName","appliedAt","appVersion","summary" FROM db_scripts ORDER BY "appliedAt"`);
        if (!rows.length) console.log('  пусто');
        for (const r of rows) {
            console.log(`  ${new Date(r.appliedAt).toISOString().slice(0, 16)}  ${r.scriptName}  (код ${r.appVersion || '—'})${r.summary ? '\n      ' + String(r.summary).slice(0, 200) : ''}`);
        }
    }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => sequelize.close());
