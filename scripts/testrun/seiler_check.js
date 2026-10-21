// Сверка данных реального клиента (Seiler) до и после прогона или обновления.
// Только читает.
//
//   node scripts/testrun/seiler_check.js snapshot [имя]   — снять снимок (tmp/seiler_<имя>.json, по умолчанию before)
//   node scripts/testrun/seiler_check.js diff [до] [после] — снять «после» и сравнить (по умолчанию before → after)
//
// Что сравнивается: счета (номер, статус, предоплата, скидка, итог, каждая строка,
// суммы по ставкам НДС), архив печати, брони (даты, статус, скидка), число записей
// в основных таблицах. Прогон работает в СВОЕЙ организации и данных Seiler касаться
// не должен; обновление не должно менять ни один выставленный документ. Любое
// расхождение — повод остановиться и разобраться.
//
// Тестовая база — копия прода (с 16.10.2026). Скрипт отказывается работать с базой,
// в имени которой нет «test».
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const { Sequelize, QueryTypes } = require(path.join(ROOT, 'node_modules', 'sequelize'));
const c = require(path.join(ROOT, 'dbSettings.postgres.json'));
if (!/test/i.test(String(c.database || ''))) {
    console.error(`ОТКАЗ: база «${c.database}» не тестовая.`);
    process.exit(1);
}
const db = new Sequelize(c.database, c.username || c.user, c.password, { host: c.host, port: c.port, dialect: 'postgres', logging: false });
const q = (sql) => db.query(sql, { type: QueryTypes.SELECT });
const ORG = `(SELECT "UID" FROM organizations WHERE name LIKE 'Gästehaus%Seiler%' LIMIT 1)`;
const file = (n) => path.join(ROOT, 'tmp', `seiler_${n}.json`);
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');

async function snapshot() {
    const out = {};
    out.invoices = await q(`SELECT i."UID", i.number, i.status, i."correctionKind", i.prepayment::text,
        i."discountValue"::text, i."discountMode", i.date, i."issuedAt" FROM invoices i
        WHERE i."organizationId" = ${ORG} ORDER BY i.number`);
    const lines = await q(`SELECT l."invoiceId", l.label, l.quantity::text, l."unitPrice"::text, l.amount::text,
        l."taxRate"::text, l."serviceId", l."guestTypeId" FROM invoice_lines l
        WHERE l."organizationId" = ${ORG} ORDER BY l."invoiceId", l."sortOrder", l.label`);
    const by = {};
    for (const l of lines) (by[l.invoiceId] = by[l.invoiceId] || []).push(l);
    for (const i of out.invoices) {
        const ls = by[i.UID] || [];
        i.lines = ls.map(l => [l.label, l.quantity, l.unitPrice, l.amount, l.taxRate, l.serviceId, l.guestTypeId].join('|'));
        i.total = ls.reduce((a, l) => a + Math.round(Number(l.amount) * 100), 0) / 100;
        const vat = {};
        for (const l of ls) vat[l.taxRate] = (vat[l.taxRate] || 0) + Math.round(Number(l.amount) * 100);
        i.byRate = vat;
    }
    out.archive = (await q(`SELECT * FROM document_archive WHERE "organizationId" = ${ORG}`).catch(() => []))
        .map(a => { const r = {}; for (const [k, v] of Object.entries(a)) r[k] = Buffer.isBuffer(v) ? hash(v) : (typeof v === 'string' && v.length > 200 ? hash(v) : v); return r; });
    out.bookings = await q(`SELECT "UID", number, "checkIn", "checkOut", "statusId", "discountValue"::text
        FROM bookings WHERE "organizationId" = ${ORG} ORDER BY number`);
    out.counts = (await q(`SELECT
        (SELECT count(*) FROM bookings WHERE "organizationId" = ${ORG}) bookings,
        (SELECT count(*) FROM invoices WHERE "organizationId" = ${ORG}) invoices,
        (SELECT count(*) FROM invoice_lines WHERE "organizationId" = ${ORG}) invoice_lines,
        (SELECT count(*) FROM clients WHERE "organizationId" = ${ORG}) clients,
        (SELECT count(*) FROM cash_receipts WHERE "organizationId" = ${ORG}) cash_receipts,
        (SELECT count(*) FROM document_archive WHERE "organizationId" = ${ORG}) archive`))[0];
    return out;
}

function diff(b, a) {
    const issues = [];
    const idx = (arr) => Object.fromEntries(arr.map(x => [x.UID, x]));
    const IB = idx(b.invoices), IA = idx(a.invoices);
    for (const [id, x] of Object.entries(IB)) {
        const y = IA[id];
        if (!y) { issues.push(`счёт ${x.number} исчез`); continue; }
        for (const k of ['number', 'status', 'correctionKind', 'prepayment', 'discountValue', 'total']) {
            if (String(x[k]) !== String(y[k])) issues.push(`счёт ${x.number}: ${k} ${x[k]} → ${y[k]}`);
        }
        if (JSON.stringify(x.lines) !== JSON.stringify(y.lines)) issues.push(`счёт ${x.number} (${x.status}): изменились строки`);
        if (JSON.stringify(x.byRate) !== JSON.stringify(y.byRate)) issues.push(`счёт ${x.number}: суммы по ставкам НДС`);
    }
    for (const id of Object.keys(IA)) if (!IB[id]) issues.push(`новый счёт ${IA[id].number} (${IA[id].status})`);
    const AB = idx(b.archive), AA = idx(a.archive);
    for (const [id, x] of Object.entries(AB)) {
        if (!AA[id]) { issues.push(`копия архива ${id} исчезла`); continue; }
        for (const k of Object.keys(x)) if (k !== 'updatedAt' && JSON.stringify(x[k]) !== JSON.stringify(AA[id][k])) issues.push(`архив ${id}: ${k}`);
    }
    const BB = idx(b.bookings), BA = idx(a.bookings);
    for (const [id, x] of Object.entries(BB)) {
        const y = BA[id];
        if (!y) { issues.push(`бронь ${x.number} исчезла`); continue; }
        for (const k of ['number', 'checkIn', 'checkOut', 'statusId', 'discountValue']) {
            if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) issues.push(`бронь ${x.number}: ${k}`);
        }
    }
    for (const k of Object.keys(b.counts)) if (b.counts[k] !== a.counts[k]) issues.push(`число записей ${k}: ${b.counts[k]} → ${a.counts[k]}`);
    return issues;
}

(async () => {
    const [cmd, n1, n2] = process.argv.slice(2);
    if (cmd === 'snapshot') {
        const s = await snapshot();
        fs.writeFileSync(file(n1 || 'before'), JSON.stringify(s, null, 1));
        console.log(`Снимок Seiler: ${file(n1 || 'before')}`, s.counts);
    } else if (cmd === 'diff') {
        const before = JSON.parse(fs.readFileSync(file(n1 || 'before'), 'utf8'));
        const after = await snapshot();
        fs.writeFileSync(file(n2 || 'after'), JSON.stringify(after, null, 1));
        const issues = diff(before, after);
        if (!issues.length) console.log('Данные Seiler не изменились.', after.counts);
        else { console.log(`РАСХОЖДЕНИЙ: ${issues.length}`); for (const i of issues) console.log('  · ' + i); process.exitCode = 2; }
    } else {
        console.log('node scripts/testrun/seiler_check.js snapshot [имя] | diff [до] [после]');
    }
    await db.close();
})().catch(e => { console.error(e.message || e); process.exitCode = 1; db.close(); });
