// ПРЯМОЙ ПОВТОР РАСЧЁТОВ на данных реального клиента (Seiler). Только читает.
//
//   node scripts/testrun/seiler_recalc.js            — сверка, подробно только расхождения
//   node scripts/testrun/seiler_recalc.js --all      — по каждой брони
//
// Зачем. Счета Seiler выставлены живым человеком и приняты гостями — это
// эталон того, как должна считаться реальная бронь. Каждая бронь, по которой
// выставлен счёт, пересчитывается ТЕКУЩИМ кодом (тот же общий модуль
// `apps/common/lib/bookingServices.js`, что у формы и проведения: buildLines +
// collapse) и сравнивается с тем, что выставлено по ней в итоге (выставленные и
// оплаченные счета, сторно и корректировки — нетто; недействительные — нет).
// Сравниваются позиции (услуга/номер, вид гостя, ставка, цена) — количество и
// сумма. Скидки счёта не сравниваются: это не расчёт брони.
//
// Расхождение — не обязательно ошибка кода: человек мог поправить счёт руками
// или изменить бронь после выставления. Такие случаи, разобранные и признанные,
// записываются в tmp/seiler_recalc_known.json — { "<номер брони>": "почему" }.
// Новое расхождение (не из списка) — ❌ в отчёт прогона: код считает не так, как
// считал, когда счёт выставляли.
//
// Тестовая база — копия прода (с 16.10.2026); скрипт отказывается работать с базой,
// в имени которой нет «test».
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
process.env.PROJECT_ROOT = process.env.PROJECT_ROOT || ROOT;
const cfg = require(path.join(ROOT, 'dbSettings.postgres.json'));
if (!/test/i.test(String(cfg.database || ''))) {
    console.error(`ОТКАЗ: база «${cfg.database}» не тестовая.`);
    process.exit(1);
}
const FW = path.join(ROOT, 'node_modules', 'my-old-space');
const gsc = require(path.join(FW, 'drive_root', 'globalServerContext'));
gsc.setProjectRoot(ROOT);
const Utilities = require(path.join(FW, 'drive_root', 'db', 'utilites'));
const M = require(path.join(FW, 'drive_root', 'db', 'money'));
const { isEmptyDate } = require(path.join(FW, 'drive_root', 'db', 'emptyValues'));
const { resolveOrgPricingMode } = require(path.join(ROOT, 'apps', 'common', 'lib', 'orgPricingMode'));
const KNOWN_FILE = path.join(ROOT, 'tmp', 'seiler_recalc_known.json');

const ISSUED = ['issued', 'paid', 'cancelled'];
const keyOf = (l) => [l.serviceId || ('room:' + (l.bookingRoomId || '')), l.guestTypeId || '', M.db(l.taxRate || 0), M.db(l.unitPrice || 0)].join('|');

function aggregate(lines) {
    const m = new Map();
    for (const l of lines) {
        const k = keyOf(l);
        const cur = m.get(k) || { q: 0, a: 0, label: l.label || '' };
        cur.q = M.add(cur.q, M.num(l.quantity));
        cur.a = M.add(cur.a, M.num(l.amount));
        m.set(k, cur);
    }
    for (const [k, v] of m) if (M.isZero(v.q) && M.isZero(v.a)) m.delete(k);
    return m;
}

(async () => {
    const all = process.argv.includes('--all');
    const modelsDB = gsc.modelsDB;
    const sq = modelsDB.Bookings.sequelize;
    const { QueryTypes } = require(path.join(ROOT, 'node_modules', 'sequelize'));
    const q = (sql, r) => sq.query(sql, { replacements: r, type: QueryTypes.SELECT });
    const known = fs.existsSync(KNOWN_FILE) ? JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8')) : {};
    const [org] = await q(`SELECT "UID" FROM organizations WHERE name LIKE 'Gästehaus%Seiler%' LIMIT 1`);
    const mode = await resolveOrgPricingMode(modelsDB, org.UID);
    const api = require(path.join(ROOT, 'apps', 'common', 'lib', 'bookingServices'))(modelsDB, Utilities);
    const taxRateRows = await modelsDB.TaxRates.findAll({ raw: true });
    const ctx = { sessionID: '__SYS_INTERNAL__' };

    const bookings = await q(`SELECT DISTINCT b."UID", b.number, b.date
        FROM bookings b JOIN invoice_lines l ON l."bookingId" = b."UID"
        JOIN invoices i ON i."UID" = l."invoiceId"
        WHERE b."organizationId" = :o AND i.status IN (:st) ORDER BY b.number`, { o: org.UID, st: ISSUED });

    let ok = 0, knownDiff = 0, newDiff = 0;
    console.log(`Seiler: режим даты цены — ${mode}; броней с выставленными счетами: ${bookings.length}\n`);
    for (const b of bookings) {
        const issuedLines = await q(`SELECT l.* FROM invoice_lines l JOIN invoices i ON i."UID" = l."invoiceId"
            WHERE l."bookingId" = :b AND i.status IN (:st)`, { b: b.UID, st: ISSUED });
        const [firstInv] = await q(`SELECT i.date FROM invoices i JOIN invoice_lines l ON l."invoiceId" = i."UID"
            WHERE l."bookingId" = :b AND i.status IN (:st) AND COALESCE(i."correctionKind", '') = ''
            ORDER BY i.date LIMIT 1`, { b: b.UID, st: ISSUED });
        const pricingDate = (mode === 'invoiceDate' && firstInv) ? firstInv.date
            : (isEmptyDate(b.date) ? new Date() : b.date);
        const built = await api.buildLines({ bookingId: b.UID, pricingDate }, ctx);
        const recomputed = api.collapse(built.lines || [], taxRateRows, built.invLang);

        const A = aggregate(issuedLines), R = aggregate(recomputed);
        const diffs = [];
        for (const k of new Set([...A.keys(), ...R.keys()])) {
            const a = A.get(k), r = R.get(k);
            const aq = a ? a.q : 0, aa = a ? a.a : 0, rq = r ? r.q : 0, ra = r ? r.a : 0;
            if (M.cmp(aq, rq) !== 0 || M.cmp(aa, ra) !== 0) {
                diffs.push(`${(a || r).label || k}: выставлено ${M.db(aq)} шт / ${M.db(aa)} €, сейчас считается ${M.db(rq)} шт / ${M.db(ra)} €`);
            }
        }
        const sumA = [...A.values()].reduce((s, v) => M.add(s, v.a), 0);
        const sumR = [...R.values()].reduce((s, v) => M.add(s, v.a), 0);
        if (!diffs.length) {
            ok++;
            if (all) console.log(`✓ ${b.number}: ${M.db(sumA)} €`);
            continue;
        }
        const why = known[b.number];
        if (why) knownDiff++; else newDiff++;
        console.log(`${why ? '≈' : '✗'} бронь ${b.number}: выставлено ${M.db(sumA)} €, сейчас ${M.db(sumR)} €${why ? '  — известно: ' + why : ''}`);
        if (!why || all) for (const d of diffs) console.log('    · ' + d);
    }
    console.log(`\nСовпало: ${ok}; известные расхождения: ${knownDiff}; НОВЫЕ расхождения: ${newDiff}`);
    if (newDiff) process.exitCode = 2;
    await sq.close();
})().catch(e => { console.error(e); process.exitCode = 1; });
