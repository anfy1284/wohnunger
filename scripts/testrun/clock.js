'use strict';

/**
 * ВИРТУАЛЬНОЕ ВРЕМЯ ТЕСТОВОГО СТЕНДА (15.10.2026).
 *
 * Зачем: прогон сценариев (tmp/СЦЕНАРИИ_ПОЛЬЗОВАТЕЛЬСКОГО_ТЕСТИРОВАНИЯ.md) должен идти не
 * одним днём, а как жизнь гостевого дома: гость заехал, через три дня уехал, ночью
 * сработало напоминание «счёт не выставлен», в конце месяца — кассовая книга.
 *
 * Как: при старте процесса подменяется глобальный `Date` — «сейчас» (`new Date()`,
 * `Date.now()`) = реальное время + сдвиг из файла `tmp/testclock.json`. Всё остальное
 * (`new Date(значение)`, `Date.parse`, `Date.UTC`) работает как обычно. SQL-часов
 * (`now()`) программа не использует — проверено поиском 15.10.2026; если появятся,
 * их придётся учесть здесь. Время продолжает ИДТИ (сдвиг, а не заморозка), и сдвигать
 * его можно только ВПЕРЁД: учёт упорядочен по моменту документа, и откат времени
 * создаёт документы «в прошлом», которых в жизни не бывает.
 *
 * ПРАВОВАЯ ГРАНИЦА (CRITICAL). Сдвиг часов в рабочей системе — это возможность задним
 * или будущим числом датировать счета и кассу (GoBD, § 146 Abs. 4 AO). Поэтому:
 *   - модуль живёт в ПРОЕКТЕ (scripts/testrun), а не во фреймворке, который продаётся;
 *   - он включается ТОЛЬКО явным `node -r ./scripts/testrun/clock.js index.js`;
 *   - он ОТКАЗЫВАЕТСЯ работать, если база не тестовая (в имени нет «test»).
 *
 * Использование:
 *   node -r ./scripts/testrun/clock.js index.js     — сервер с виртуальным временем
 *   node scripts/testrun/clock.js show               — текущее виртуальное время
 *   node scripts/testrun/clock.js +3d                — вперёд на 3 дня (h — часы, m — минуты)
 *   node scripts/testrun/clock.js 2026-11-01T09:00   — вперёд до момента (местное время)
 *   node scripts/testrun/clock.js reset              — сдвиг 0 (только если это не назад)
 *
 * Сервер подхватывает новый сдвиг сам в течение секунды — перезапуск не нужен.
 * Воркеры (планировщик, проведение) получают модуль через NODE_OPTIONS.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FILE = path.join(ROOT, 'tmp', 'testclock.json');

function readOffset() {
    try {
        const v = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        const n = Number(v && v.offsetMs);
        return isFinite(n) ? n : 0;
    } catch (e) {
        return 0;
    }
}

/** Имя базы из настроек проекта — для стража «только тестовая база». */
function databaseName() {
    try {
        const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'dbSettings.postgres.json'), 'utf8'));
        const c = s.postgres || s;
        return String(c.database || '');
    } catch (e) {
        return '';
    }
}

function assertTestDatabase() {
    const db = databaseName();
    if (!/test/i.test(db)) {
        console.error(`[testclock] ОТКАЗ: база «${db}» не тестовая. Виртуальное время включается только на тестовой базе.`);
        process.exit(1);
    }
    return db;
}

// ── Режим 1: подгружен через -r — подменяем часы процесса ─────────────────────
function install() {
    const db = assertTestDatabase();
    const RealDate = Date;
    let offset = readOffset();
    let mtime = 0;
    try { mtime = fs.statSync(FILE).mtimeMs; } catch (e) {}

    const now = () => RealDate.now() + offset;

    function VirtualDate(...args) {
        if (!new.target) return new RealDate(now()).toString();
        return args.length ? new RealDate(...args) : new RealDate(now());
    }
    VirtualDate.prototype = RealDate.prototype;
    Object.setPrototypeOf(VirtualDate, RealDate);
    VirtualDate.now = now;
    VirtualDate.parse = RealDate.parse;
    VirtualDate.UTC = RealDate.UTC;
    global.Date = VirtualDate;

    // Сдвиг меняют командой из другого процесса — подхватываем по времени изменения файла.
    const timer = setInterval(() => {
        try {
            const m = fs.statSync(FILE).mtimeMs;
            if (m !== mtime) {
                mtime = m;
                offset = readOffset();
                console.log(`[testclock] виртуальное время: ${new RealDate(now()).toISOString()}`);
            }
        } catch (e) { /* файла нет — сдвиг прежний */ }
    }, 1000);
    if (timer.unref) timer.unref();

    // Форкнутые процессы (воркер планировщика, проведение) — те же часы.
    const self = __filename.replace(/\\/g, '/');
    if (!String(process.env.NODE_OPTIONS || '').includes(self)) {
        process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require "${self}"`.trim();
    }

    if (!global.__testclockAnnounced) {
        global.__testclockAnnounced = true;
        console.log(`[testclock] ВИРТУАЛЬНОЕ ВРЕМЯ включено (база ${db}), сейчас: ${new RealDate(now()).toISOString()}`);
    }
}

// ── Режим 2: командная строка — показать или сдвинуть время ───────────────────
/**
 * Момент из строки: ДД.ММ.ГГГГ[ ЧЧ:ММ[:СС]] или всё, что понимает `Date`.
 *
 * Своя разборка нужна ровно для точечного формата: `new Date('01.10.2026')` в
 * V8 читается как МЕСЯЦ.ДЕНЬ и даёт 10 января — а стенд, сценарии и интерфейс
 * пишут дату по-немецки (прогон 16.10.2026, T4). Молча сдвинуть время на девять
 * месяцев хуже, чем не понять строку, поэтому формат разбирается явно.
 *
 * @returns {number|null} миллисекунды или null, если строку не разобрать
 */
function parseMoment(s) {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(s).trim());
    if (m) {
        const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]),
            Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
        // Несуществующая дата (31.02) не бросает, а «переезжает» на март —
        // такое принимать нельзя: человек ошибся, а время сдвинется молча.
        if (d.getDate() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1) return null;
        return d.getTime();
    }
    const t = new Date(s).getTime();
    return isFinite(t) ? t : null;
}

function cli(argv) {
    assertTestDatabase();
    const arg = argv[0] || 'show';
    const current = readOffset();
    const virtualNow = Date.now() + current;
    const fmt = (ms) => new Date(ms).toLocaleString('de-DE');

    if (arg === 'show') {
        console.log(`Виртуальное время: ${fmt(virtualNow)} (сдвиг ${(current / 86400000).toFixed(2)} дн.)`);
        return;
    }

    let target;
    if (arg === 'reset') {
        target = Date.now();
    } else {
        const rel = /^\+(\d+(?:\.\d+)?)([dhm])$/.exec(arg);
        if (rel) {
            const k = { d: 86400000, h: 3600000, m: 60000 }[rel[2]];
            target = virtualNow + Number(rel[1]) * k;
        } else {
            const t = parseMoment(arg);
            if (t === null) { console.error('Не понял время: ' + arg + ' (ожидается ДД.ММ.ГГГГ[ ЧЧ:ММ], ISO или +3d/+2h/+30m)'); process.exit(1); }
            target = t;
        }
    }
    if (target < virtualNow - 1000 && !argv.includes('--force')) {
        console.error(`ОТКАЗ: ${fmt(target)} раньше текущего виртуального ${fmt(virtualNow)}. Время на стенде идёт только вперёд.`);
        process.exit(1);
    }
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ offsetMs: target - Date.now(), setAt: new Date().toISOString() }, null, 2));
    console.log(`Виртуальное время: ${fmt(target)}`);
}

if (require.main === module) cli(process.argv.slice(2));
else install();
