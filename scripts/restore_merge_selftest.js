'use strict';
/**
 * ПРОВЕРКА СЛИЯНИЯ СИСТЕМНЫХ ДАННЫХ (`mergeUsers`) на КЛОНЕ структуры живой базы.
 *
 * Дополняет `restore_selftest.js`: тот прогоняет фазы на настоящей копии, а здесь
 * проверяются РАСХОЖДЕНИЯ, которых в свежей копии нет и которые как раз ломают слияние —
 * пользователь, заведённый после снятия копии; удалённый после снятия (обязан вернуться
 * выключенным); роль и настройка, появившиеся позже.
 *
 * `public` только читается. Клон строится в схеме `mos_selftest_<метка>`, играет роль
 * теневой схемы (содержимого копии), в конце удаляется.
 *
 *   node tmp/restore_merge_selftest.js
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.env.PROJECT_ROOT = ROOT;

const FW = path.join(ROOT, 'node_modules', 'my-old-space');
const sequelize = require(path.join(FW, 'drive_root/db/sequelize_instance'));
const dialect = require(path.join(FW, 'drive_root/backup/dialect'));
const { mergeUsers } = require(path.join(FW, 'drive_root/backup/systemDataUsers'));

const SHADOW = 'mos_selftest_' + Date.now().toString(36);
const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';

const SYS_TABLES = ['users', 'sessions', 'user_settings_string_values', 'user_settings_number_values',
    'user_settings_boolean_values', 'user_settings_date_values', 'systems', 'access_roles', 'user_systems'];

async function main() {
    const tables = (await sequelize.query(
        `SELECT table_name AS t FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE'`, { type: sequelize.QueryTypes.SELECT }
    )).map(r => r.t);

    // Определения внешних ключей читаем ПРИ public в пути поиска: тогда цель печатается
    // без схемы и при применении разрешится внутри клона.
    const fkDefs = await sequelize.query(
        `SELECT c.conname AS name, t.relname AS tbl, pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE c.contype='f' AND n.nspname='public'`, { type: sequelize.QueryTypes.SELECT });

    console.log(`Клон: ${SHADOW}; таблиц ${tables.length}, внешних ключей ${fkDefs.length}`);
    await sequelize.query(`CREATE SCHEMA ${q(SHADOW)}`);
    try {
        for (const t of tables) {
            await sequelize.query(`CREATE TABLE ${q(SHADOW)}.${q(t)} (LIKE public.${q(t)} INCLUDING ALL)`);
            await sequelize.query(`INSERT INTO ${q(SHADOW)}.${q(t)} SELECT * FROM public.${q(t)}`);
        }
        for (const fk of fkDefs) {
            await sequelize.query(`SET search_path TO ${q(SHADOW)}`);
            await sequelize.query(`ALTER TABLE ${q(SHADOW)}.${q(fk.tbl)} ADD CONSTRAINT ${q(fk.name)} ${fk.def}`);
            await sequelize.query(`SET search_path TO public`);
        }

        // ── Расхождения, изображающие годичную копию ────────────────────────────────
        // 1. Пользователь, заведённый ПОСЛЕ снятия копии: есть в live, нет в клоне.
        const victim = (await sequelize.query(
            `SELECT ${q('UID')} AS uid FROM ${q(SHADOW)}.users ORDER BY ${q('UID')} LIMIT 1`,
            { type: sequelize.QueryTypes.SELECT }))[0];
        if (victim) {
            for (const t of tables) {
                const cols = (await sequelize.query(
                    `SELECT column_name AS c FROM information_schema.columns
                      WHERE table_schema=:s AND table_name=:t`,
                    { replacements: { s: SHADOW, t }, type: sequelize.QueryTypes.SELECT })).map(r => r.c);
                for (const c of ['userId', 'ownerId']) {
                    if (cols.includes(c)) {
                        await sequelize.query(`DELETE FROM ${q(SHADOW)}.${q(t)} WHERE ${q(c)} = :u`,
                            { replacements: { u: victim.uid } });
                    }
                }
            }
            await sequelize.query(`DELETE FROM ${q(SHADOW)}.users WHERE ${q('UID')} = :u`,
                { replacements: { u: victim.uid } });
            console.log(`  live-пользователь, отсутствующий в копии: ${victim.uid}`);
        }
        // 2. Пользователь, удалённый ПОСЛЕ снятия копии: есть в клоне, нет в live.
        //    Обязан вернуться выключенным.
        await sequelize.query(
            `INSERT INTO ${q(SHADOW)}.users (${q('UID')}, email, name, ${q('isGuest')}, language,
                 ${q('mustChangePassword')}, disabled, ${q('createdAt')}, ${q('updatedAt')})
             VALUES ('selftest-gone', 'gone@example.com', 'Уволенный', false, 'ru', false, false, now(), now())`);
        // 3. Роль, заведённая ПОСЛЕ снятия копии: есть в live, нет в клоне.
        const role = (await sequelize.query(
            `SELECT ${q('UID')} AS uid FROM ${q(SHADOW)}.access_roles
              WHERE ${q('UID')} NOT IN (SELECT ${q('roleId')} FROM ${q(SHADOW)}.user_systems WHERE ${q('roleId')} IS NOT NULL)
              LIMIT 1`, { type: sequelize.QueryTypes.SELECT }))[0];
        if (role) {
            await sequelize.query(`DELETE FROM ${q(SHADOW)}.access_roles WHERE ${q('UID')} = :u`,
                { replacements: { u: role.uid } });
            console.log(`  live-роль, отсутствующая в копии: ${role.uid}`);
        }
        // 4. Настройка, заведённая ПОСЛЕ снятия копии: её значения не перенести.
        const field = (await sequelize.query(
            `SELECT f.${q('UID')} AS uid FROM ${q(SHADOW)}.user_settings_fields f
              WHERE EXISTS (SELECT 1 FROM ${q(SHADOW)}.user_settings_string_values v
                             WHERE v.${q('settingsFieldId')} = f.${q('UID')}) LIMIT 1`,
            { type: sequelize.QueryTypes.SELECT }))[0];
        if (field) {
            await sequelize.query(
                `DELETE FROM ${q(SHADOW)}.user_settings_string_values WHERE ${q('settingsFieldId')} = :u`,
                { replacements: { u: field.uid } });
            await sequelize.query(`DELETE FROM ${q(SHADOW)}.user_settings_fields WHERE ${q('UID')} = :u`,
                { replacements: { u: field.uid } });
            console.log(`  live-настройка, отсутствующая в копии: ${field.uid}`);
        }

        // ── Собственно прогон ──────────────────────────────────────────────────────
        const present = [];
        for (const t of SYS_TABLES) if (tables.includes(t)) present.push(t);
        console.log('\n--- mergeUsers ---');
        const stats = await mergeUsers({
            sequelize, q, shadow: SHADOW, live: 'public', tables: present,
            report: (text) => console.log('  ' + text)
        });
        console.log('stats:', JSON.stringify(stats));

        // ── Что получилось ─────────────────────────────────────────────────────────
        const chk = async (sql) => (await sequelize.query(sql, { type: sequelize.QueryTypes.SELECT }))[0];
        console.log('\n--- проверки ---');
        console.log('вернулся выключенным:', JSON.stringify(await chk(
            `SELECT disabled FROM ${q(SHADOW)}.users WHERE ${q('UID')}='selftest-gone'`)));
        if (victim) console.log('live-пользователь добавлен:', JSON.stringify(await chk(
            `SELECT ${q('UID')} AS uid, ${q('organizationId')} AS org, disabled FROM ${q(SHADOW)}.users WHERE ${q('UID')}='${victim.uid}'`)));
        console.log('ролей в клоне vs live:', JSON.stringify(await chk(
            `SELECT (SELECT COUNT(*) FROM ${q(SHADOW)}.access_roles) AS shadow,
                    (SELECT COUNT(*) FROM public.access_roles) AS live`)));
        console.log('привязок в клоне vs live:', JSON.stringify(await chk(
            `SELECT (SELECT COUNT(*) FROM ${q(SHADOW)}.user_systems) AS shadow,
                    (SELECT COUNT(*) FROM public.user_systems) AS live`)));
        console.log('сессий в клоне:', JSON.stringify(await chk(
            `SELECT COUNT(*) AS n FROM ${q(SHADOW)}.sessions`)));
        console.log('строковых настроек клон vs live:', JSON.stringify(await chk(
            `SELECT (SELECT COUNT(*) FROM ${q(SHADOW)}.user_settings_string_values) AS shadow,
                    (SELECT COUNT(*) FROM public.user_settings_string_values) AS live`)));
        console.log('\nПРОГОН БЕЗ ОШИБОК');
    } finally {
        await sequelize.query(`SET search_path TO public`);
        await sequelize.query(`DROP SCHEMA IF EXISTS ${q(SHADOW)} CASCADE`);
        console.log(`Клон ${SHADOW} удалён`);
        await sequelize.close();
    }
}

main().catch(async (e) => {
    console.error('ОШИБКА ПРОГОНА:', e.message);
    try { await sequelize.query(`SET search_path TO public`); await sequelize.query(`DROP SCHEMA IF EXISTS ${q(SHADOW)} CASCADE`); } catch (e2) {}
    try { await sequelize.close(); } catch (e2) {}
    process.exit(1);
});
