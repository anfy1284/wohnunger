'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Движок пользовательских формул расчёта (ЕДИНЫЙ источник истины).
//
// Назначение: вычислять произвольную формулу количества услуги
// (services.quantityFormula) с предопределёнными переменными.
//
// Безопасность: НИКАКОГО eval/Function. Собственный рекурсивный парсер
// арифметики — поэтому формулу безопасно вычислять и на сервере.
//
// Переменные обозначаются ПРЕФИКСОМ '@' (напр. @nights). Реестр переменных
// (VARIABLES) — ЕДИНСТВЕННОЕ место, куда добавляются новые переменные:
// сервер резолвит значения (resolveVariables) и отдаёт метаданные клиенту
// (listVariables) для легенды редактора формул. Дублирования логики нет —
// и расчёт, и легенда, и список идентификаторов берутся отсюда.
// ─────────────────────────────────────────────────────────────────────────────

const PREFIX = '@';

// ── Реестр переменных ───────────────────────────────────────────────────────
//   id             — внутреннее имя (= токен без префикса), ключ в values
//   token          — как пишется в формуле (с префиксом): '@nights'
//   descriptionKey — ключ i18n для описания (резолвит вызывающий: tForSession)
//   resolve(ctx)   — значение переменной из контекста брони
const VARIABLES = [
    {
        id: 'nights',
        token: PREFIX + 'nights',
        descriptionKey: 'formula_var_nights',
        resolve: (ctx) => {
            const ci = ctx && ctx.checkIn ? new Date(ctx.checkIn) : null;
            const co = ctx && ctx.checkOut ? new Date(ctx.checkOut) : null;
            if (!ci || !co || isNaN(ci.getTime()) || isNaN(co.getTime())) return 0;
            const n = Math.round((co - ci) / 86400000);
            return n > 0 ? n : 0;
        }
    }
];

// Значения всех переменных по контексту брони → { nights: 5, ... }
function resolveVariables(ctx) {
    const out = {};
    for (const v of VARIABLES) {
        try { out[v.id] = Number(v.resolve(ctx)) || 0; } catch (_) { out[v.id] = 0; }
    }
    return out;
}

// Метаданные переменных для клиента (легенда редактора).
// Описание (по descriptionKey) переводит вызывающий — здесь язык не известен.
function listVariables() {
    return VARIABLES.map(v => ({ id: v.id, token: v.token, descriptionKey: v.descriptionKey }));
}

// ── Допустимые функции в формуле ─────────────────────────────────────────────
// Булевы значения представляются числами: 0 = ложь, любое ≠0 = истина.
// if(условие, A, B) → A, если условие истинно (≠0), иначе B. Обе ветви —
// чистые числа без побочных эффектов, поэтому безопасно вычислять их обе
// (eager) до выбора результата (деление на 0 уже даёт 0, см. parseTerm).
const FUNCS = {
    round: Math.round, floor: Math.floor, ceil: Math.ceil, abs: Math.abs,
    min: Math.min, max: Math.max, sqrt: Math.sqrt,
    if: (c, a, b) => (Number(c) !== 0 ? a : b)
};

// ── Метаданные функций для легенды редактора (единый источник) ───────────────
//   display        — как показать в подсказке
//   insert         — что вставить в формулу по клику (открывающая скобка)
//   descriptionKey — ключ i18n описания (резолвит вызывающий: tForSession)
const FUNCTIONS = [
    { display: 'if(cond; A; B)', insert: 'if(',    descriptionKey: 'formula_fn_if' },
    { display: 'min(a; b)',      insert: 'min(',   descriptionKey: 'formula_fn_min' },
    { display: 'max(a; b)',      insert: 'max(',   descriptionKey: 'formula_fn_max' },
    { display: 'round(x)',          insert: 'round(', descriptionKey: 'formula_fn_round' },
    { display: 'ceil(x)',           insert: 'ceil(',  descriptionKey: 'formula_fn_ceil' },
    { display: 'floor(x)',          insert: 'floor(', descriptionKey: 'formula_fn_floor' },
    { display: 'abs(x)',            insert: 'abs(',   descriptionKey: 'formula_fn_abs' }
];

// Метаданные функций для клиента (легенда редактора). Описание переводит
// вызывающий (язык здесь не известен) — как и у переменных.
function listFunctions() {
    return FUNCTIONS.map(f => ({ display: f.display, insert: f.insert, descriptionKey: f.descriptionKey }));
}

const RE_IDENT = /[A-Za-z0-9_]/;
const RE_IDENT_START = /[A-Za-z_]/;

// ── Токенайзер ───────────────────────────────────────────────────────────────
function tokenize(src) {
    const s = String(src);
    const tokens = [];
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
        if ((ch >= '0' && ch <= '9') || (ch === '.' && s[i + 1] >= '0' && s[i + 1] <= '9')) {
            let j = i + 1;
            while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j++;
            tokens.push({ t: 'num', v: parseFloat(s.slice(i, j)) });
            i = j; continue;
        }
        if (ch === PREFIX) {
            let j = i + 1;
            while (j < s.length && RE_IDENT.test(s[j])) j++;
            const name = s.slice(i + 1, j);
            if (!name) throw new Error('Bad variable token at ' + i);
            tokens.push({ t: 'var', v: name });
            i = j; continue;
        }
        if (RE_IDENT_START.test(ch)) {
            let j = i + 1;
            while (j < s.length && RE_IDENT.test(s[j])) j++;
            tokens.push({ t: 'ident', v: s.slice(i, j) });
            i = j; continue;
        }
        // Двухсимвольные операторы сравнения/логики (проверяем раньше односимвольных).
        const ch2 = s[i + 1];
        if (ch === '>' && ch2 === '=') { tokens.push({ t: 'op', v: '>=' }); i += 2; continue; }
        if (ch === '<' && ch2 === '=') { tokens.push({ t: 'op', v: '<=' }); i += 2; continue; }
        if (ch === '=' && ch2 === '=') { tokens.push({ t: 'op', v: '==' }); i += 2; continue; }
        if (ch === '!' && ch2 === '=') { tokens.push({ t: 'op', v: '!=' }); i += 2; continue; }
        if (ch === '&' && ch2 === '&') { tokens.push({ t: 'op', v: '&&' }); i += 2; continue; }
        if (ch === '|' && ch2 === '|') { tokens.push({ t: 'op', v: '||' }); i += 2; continue; }
        // Одиночный '=' трактуем как равенство (дружелюбно к не-программистам).
        if (ch === '=') { tokens.push({ t: 'op', v: '==' }); i++; continue; }
        // ';' — разделитель аргументов как в европейском/немецком Excel; нормализуем в ','.
        if (ch === ';') { tokens.push({ t: 'op', v: ',' }); i++; continue; }
        if ('+-*/%(),><!?:'.indexOf(ch) >= 0) { tokens.push({ t: 'op', v: ch }); i++; continue; }
        throw new Error('Bad character "' + ch + '" at ' + i);
    }
    return tokens;
}

// ── Парсер (рекурсивный спуск) + вычисление ──────────────────────────────────
// evaluate(formula, values): values — карта { имяПеременной: число }.
// Возвращает число; null для пустой формулы; бросает Error на синтаксис/неизвестные
// переменные/функции.
function evaluate(formula, values) {
    const f = (formula == null ? '' : String(formula)).trim();
    if (!f) return null;
    const toks = tokenize(f);
    let pos = 0;
    const peek = () => toks[pos];
    const next = () => toks[pos++];
    const expect = (v) => { const t = next(); if (!t || t.v !== v) throw new Error('Expected "' + v + '"'); };

    const isOp = (v) => { const t = peek(); return t && t.t === 'op' && t.v === v; };

    // Верхний уровень грамматики (по убыванию приоритета):
    //   ?:  →  ||  →  &&  →  сравнение  →  +/-  →  */%  →  унарный  →  primary
    function parseExpr() { return parseTernary(); }

    function parseTernary() {
        const cond = parseOr();
        if (isOp('?')) {
            next();
            const a = parseTernary();
            if (!isOp(':')) throw new Error('Expected ":" in ternary');
            next();
            const b = parseTernary();
            return (cond !== 0) ? a : b;
        }
        return cond;
    }
    function parseOr() {
        let val = parseAnd();
        while (isOp('||')) { next(); const rhs = parseAnd(); val = (val !== 0 || rhs !== 0) ? 1 : 0; }
        return val;
    }
    function parseAnd() {
        let val = parseCompare();
        while (isOp('&&')) { next(); const rhs = parseCompare(); val = (val !== 0 && rhs !== 0) ? 1 : 0; }
        return val;
    }
    function parseCompare() {
        let val = parseAdd();
        // Сравнения не-ассоциативны: одно на уровень (a > b), результат — 1/0.
        if (peek() && peek().t === 'op' && ['>', '<', '>=', '<=', '==', '!='].indexOf(peek().v) >= 0) {
            const op = next().v;
            const rhs = parseAdd();
            switch (op) {
                case '>':  return val >  rhs ? 1 : 0;
                case '<':  return val <  rhs ? 1 : 0;
                case '>=': return val >= rhs ? 1 : 0;
                case '<=': return val <= rhs ? 1 : 0;
                case '==': return val === rhs ? 1 : 0;
                case '!=': return val !== rhs ? 1 : 0;
            }
        }
        return val;
    }
    function parseAdd() {
        let val = parseTerm();
        while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
            const op = next().v;
            const rhs = parseTerm();
            val = op === '+' ? val + rhs : val - rhs;
        }
        return val;
    }
    function parseTerm() {
        let val = parseFactor();
        while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/' || peek().v === '%')) {
            const op = next().v;
            const rhs = parseFactor();
            if (op === '*') val = val * rhs;
            else if (op === '/') val = (rhs === 0) ? 0 : val / rhs;
            else val = (rhs === 0) ? 0 : val % rhs;
        }
        return val;
    }
    function parseFactor() {
        const t = peek();
        if (t && t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '!')) {
            next();
            const v = parseFactor();
            if (t.v === '-') return -v;
            if (t.v === '!') return (v !== 0) ? 0 : 1;   // логическое НЕ → 1/0
            return v;
        }
        return parsePrimary();
    }
    function parsePrimary() {
        const t = next();
        if (!t) throw new Error('Unexpected end of formula');
        if (t.t === 'num') return t.v;
        if (t.t === 'var') {
            if (!values || !(t.v in values)) throw new Error('Unknown variable ' + PREFIX + t.v);
            return Number(values[t.v]) || 0;
        }
        if (t.t === 'ident') {
            const fn = FUNCS[t.v];
            if (!fn) throw new Error('Unknown function ' + t.v);
            expect('(');
            const args = [];
            if (!(peek() && peek().t === 'op' && peek().v === ')')) {
                args.push(parseExpr());
                while (peek() && peek().t === 'op' && peek().v === ',') { next(); args.push(parseExpr()); }
            }
            expect(')');
            return fn.apply(null, args);
        }
        if (t.t === 'op' && t.v === '(') {
            const v = parseExpr();
            expect(')');
            return v;
        }
        throw new Error('Unexpected token ' + JSON.stringify(t));
    }

    const result = parseExpr();
    if (pos !== toks.length) throw new Error('Trailing tokens in formula');
    if (typeof result !== 'number' || !isFinite(result)) throw new Error('Formula did not evaluate to a finite number');
    return result;
}

module.exports = { PREFIX, VARIABLES, FUNCTIONS, resolveVariables, listVariables, listFunctions, evaluate };
