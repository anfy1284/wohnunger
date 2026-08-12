'use strict';
/**
 * ПРОВЕРКА ПОЛНОГО ВОССТАНОВЛЕНИЯ — все фазы, кроме переключения.
 *
 * Зачем отдельным скриптом. Восстановление ломается там, где его никто не смотрит: код
 * исполняется в форкнутом процессе, часть веток вызывается раз в год, а отказ приходит
 * сообщением СУБД, которое называет МЕСТО аварии, а не причину. Единственный надёжный
 * ответ на «работает ли восстановление» — прогнать его фазы на настоящем файле копии.
 *
 * Безопасность: строит всё в схеме `mos_selftest_<метка>`, переключение схем НЕ делает,
 * `public` только читает (системные данные переносятся ИЗ живой схемы В тестовую), в
 * конце схему удаляет. Живая база не меняется.
 *
 *   node tmp/restore_selftest.js <путь-к-.mosbak>
 *
 * Копия должна быть НЕзашифрованной (снятая без публичного ключа либо расшифрованная).
 * Ненулевой код возврата = восстановление этой копии упало бы.
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.env.PROJECT_ROOT = ROOT;

const FW = path.join(ROOT, 'node_modules', 'my-old-space');
const gsc = require(path.join(FW, 'drive_root/globalServerContext'));
gsc.setProjectRoot(ROOT);

const sequelize = require(path.join(FW, 'drive_root/db/sequelize_instance'));
const restoreFull = require(path.join(FW, 'drive_root/backup/restoreFull'));
const schemaBuilder = require(path.join(FW, 'drive_root/db/schemaBuilder'));
const systemData = require(path.join(FW, 'drive_root/backup/systemDataStrategies'));

const FILE = process.argv[2];
const SCHEMA = 'mos_selftest_' + Date.now().toString(36);

/** Отказ печатается вместе с SQL: без него сообщение СУБД указывает не туда. */
function boom(where, e) {
    console.error(`\n!!! ОТКАЗ НА ШАГЕ: ${where}`);
    console.error('сообщение:', e.message);
    if (e.original) console.error('драйвер:', e.original.message, '| detail:', e.original.detail || '');
    if (e.sql) console.error('SQL:', String(e.sql).slice(0, 1500));
    console.error('стек:', String(e.stack).split('\n').slice(0, 8).join('\n'));
}

async function main() {
    if (!FILE) {
        console.error('Укажите путь к файлу копии: node tmp/restore_selftest.js <файл.mosbak>');
        process.exit(2);
    }

    const info = await restoreFull.inspect(sequelize, FILE);
    console.log(`копия: ${path.basename(FILE)} | dbVersion ${info.dbVersion} | scope ${info.scopeType}`
        + ` | строк в заголовке ${info.header.rowsTotal || 0} | режим ${info.mode}`);
    if (info.encrypted) {
        console.error('Копия зашифрована — проверка требует незашифрованной копии.');
        process.exit(2);
    }

    const { models } = await restoreFull.readModelsSection(FILE, '', undefined);
    console.log(`снимок структуры: ${models.length} таблиц; схема прогона: ${SCHEMA}`);
    await sequelize.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sequelize.query(`CREATE SCHEMA "${SCHEMA}"`);

    let failed = false;
    try {
        console.log('\n[1] структура');
        const built = await schemaBuilder.buildSchema(sequelize, models, { schema: SCHEMA, withoutForeignKeys: true });
        if (built.failed.length) {
            console.error('НЕ СОЗДАНЫ:', JSON.stringify(built.failed).slice(0, 800));
            return (failed = true);
        }
        console.log(`    таблиц: ${models.length}`);

        console.log('\n[2] данные');
        let lastPct = -1;
        const loaded = await restoreFull.loadRows({
            sequelize, filePath: FILE, privateKeyPem: '', passphrase: undefined,
            schema: SCHEMA, dumpModels: models,
            rowsTotal: Number(info.header.rowsTotal) || 0,
            // Заодно видно, движется ли полоса прогресса: молчащая фаза данных — дефект.
            report: (ph, t, p) => {
                if (!p || !p.total) return;
                const pct = Math.round(100 * p.done / p.total);
                if (pct !== lastPct && pct % 20 === 0) { process.stdout.write(`    ${pct}%\n`); lastPct = pct; }
            }
        }).catch(e => { boom('загрузка данных', e); failed = true; return null; });
        if (!loaded) return;
        console.log(`    строк: ${loaded.totalRows}`);

        console.log('\n[3] внешние ключи');
        const fk = await restoreFull.addForeignKeys(sequelize, models, { schema: SCHEMA, report: () => {} });
        console.log(`    создано: ${fk.created.length} | отказов: ${fk.failed.length}`);
        if (fk.failed.length) {
            console.error('    ОТКАЗЫ:', JSON.stringify(fk.failed.slice(0, 5)));
            return (failed = true);
        }

        console.log('\n[4] системные данные (перенос из живой схемы)');
        const currentModels = gsc.collectMergedModelDefs().models || [];
        const res = await systemData.applyAll({
            sequelize, shadow: SCHEMA, models: currentModels, restoreFromCopy: {},
            report: (t) => console.log('    ' + t)
        }).catch(e => { boom('системные данные', e); failed = true; return null; });
        if (!res) return;
        console.log('    применено:', JSON.stringify(res));

        console.log('\nВСЕ ФАЗЫ ДО ПЕРЕКЛЮЧЕНИЯ ПРОШЛИ');
    } finally {
        await sequelize.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        console.log(`схема ${SCHEMA} удалена`);
        await sequelize.close();
        if (failed) process.exitCode = 1;
    }
}

main().catch(async (e) => {
    boom('вне фаз', e);
    try { await sequelize.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`); await sequelize.close(); } catch (x) {}
    process.exit(1);
});
