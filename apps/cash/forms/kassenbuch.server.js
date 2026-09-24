'use strict';

/**
 * Отчёт «Кассовая книга» (Kassenbuch) — ТЗ §19, этап 10.
 *
 * Зачем он нужен отдельно от регистра. Регистр отдаёт остаток на любой момент, но
 * при проверке спрашивают саму КНИГУ: список операций по одному месту хранения за
 * период, с нарастающим остатком и итогами за день. Собственной логики расчёта у
 * отчёта нет — он читает уже посчитанные движения, поэтому разойтись с остатком
 * регистра ему негде.
 *
 * ── Правовое ──────────────────────────────────────────────────────────────────
 * § 146 Abs. 1 Satz 2 AO: кассовые поступления и выдачи записываются ЕЖЕДНЕВНО
 * («sollen täglich»). Норма мягкая («soll»), но отступление — формальный
 * недостаток кассового учёта и повод для претензий, поэтому в книге печатается
 * дата ОПЕРАЦИИ (когда деньги реально двигались), а дата ввода видна отдельно:
 * запись задним числом обязана быть прослеживаемой, а не замаскированной.
 *
 * § 146 Abs. 1 AO, Einzelaufzeichnungspflicht: одна операция — одна строка.
 * Свёртка нескольких платежей в одну запись запрещена, поэтому отчёт печатает
 * ДВИЖЕНИЯ, а не суммы по дням; итог дня идёт отдельной строкой ПОВЕРХ них.
 *
 * Позиция BMF: карточные обороты в кассовую книгу не попадают. Отчёт строится по
 * ОДНОМУ месту хранения, и наличная касса, банковский счёт и «карточные платежи
 * в пути» — разные места; смешать их нельзя по устройству.
 */

const path = require('path');
const FW = path.join(__dirname, '..', '..', '..', 'node_modules', 'my-old-space');
const dbGateway = require(path.join(FW, 'drive_root', 'dbGateway'));
const money = require(path.join(FW, 'drive_root', 'db', 'money'));
const registers = require(path.join(FW, 'drive_root', 'db', 'registers'));

module.exports = function (modelsDB, Utilities) {

    function esc(v) {
        return String(v === null || v === undefined ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function fmtDate(v, lang) {
        if (!v) return '';
        const d = new Date(v);
        if (isNaN(d.getTime())) return '';
        // Ведущие нули обязательны: это юридический документ.
        const p = n => String(n).padStart(2, '0');
        return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
    }

    function fmtMoney(v) {
        const n = money.num(v);
        return money.db(n).replace('.', ',');
    }

    function dayKey(v) {
        const d = new Date(v);
        return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
    }

    async function tr(ctx, key, fallback) {
        try {
            const { tForSession } = require(path.join(FW, 'drive_forms', 'globalServerContext'));
            const v = await tForSession(key, ctx && ctx.sessionID);
            if (v && v !== key) return v;
        } catch (e) { /* перевода нет */ }
        return fallback;
    }

    /**
     * Построить кассовую книгу.
     *
     * @param {object} params — `{ cashboxId, organizationId, from, to }`
     * @returns {Promise<{ok:boolean, html:string}>}
     */
    async function build(params, ctx) {
        const sessionID = ctx && ctx.sessionID;
        const { cashboxId, organizationId } = params || {};
        if (!cashboxId) {
            return { error: await tr(ctx, 'cash_kb_err_no_cashbox', 'Не выбрано место хранения денег') };
        }
        const from = params.from ? new Date(params.from) : new Date(Date.now() - 30 * 86400000);
        const to = params.to ? new Date(params.to) : new Date();

        // ОСТАТОК НА НАЧАЛО — тем же механизмом, что и всё остальное: сумма
        // движений строго до начала периода. Своего SQL у отчёта нет.
        const openingRows = await registers.balance({
            register: 'reg_cash',
            dimensions: { cashboxId, organizationId },
            moment: { date: new Date(from.getTime() - 1), seq: null },
            context: { sessionID }
        });
        let running = money.num((openingRows && openingRows[0] && openingRows[0].amount) || 0);
        const opening = running;

        // Движения периода. `period` — момент времени РЕГИСТРАТОРА, то есть дата
        // документа; дата операции берётся из самого документа ниже.
        const { Op } = require('sequelize');
        const movements = await dbGateway.execute({
            operation: 'read', table: 'reg_cash',
            where: { cashboxId, period: { [Op.gte]: from, [Op.lte]: to } },
            options: { raw: true, order: [['period', 'ASC'], ['seq', 'ASC'], ['lineNo', 'ASC']] },
            context: { sessionID }
        });

        // Реквизиты документов-регистраторов: номер, дата операции, содержание.
        // Один запрос на вид документа, а не на строку.
        const byTable = new Map();
        for (const m of movements || []) {
            if (!m.recorderTable || !m.recorderUID) continue;
            if (!byTable.has(m.recorderTable)) byTable.set(m.recorderTable, new Set());
            byTable.get(m.recorderTable).add(m.recorderUID);
        }
        const docs = new Map();
        for (const [table, uids] of byTable) {
            try {
                const rows = await dbGateway.execute({
                    operation: 'read', table,
                    where: { UID: { [Op.in]: Array.from(uids) } },
                    options: { raw: true },
                    context: { sessionID }
                });
                for (const r of rows || []) docs.set(table + '|' + r.UID, r);
            } catch (e) {
                console.error(`[kassenbuch] ${table}: регистраторы не прочитаны: ${e.message}`);
            }
        }

        const L = {
            title: await tr(ctx, 'cash_kb_title', 'Kassenbuch'),
            period: await tr(ctx, 'cash_kb_period', 'Zeitraum'),
            opening: await tr(ctx, 'cash_kb_opening', 'Anfangsbestand'),
            closing: await tr(ctx, 'cash_kb_closing', 'Endbestand'),
            date: await tr(ctx, 'cash_kb_col_date', 'Datum'),
            number: await tr(ctx, 'cash_kb_col_number', 'Beleg-Nr.'),
            text: await tr(ctx, 'cash_kb_col_text', 'Vorgang'),
            income: await tr(ctx, 'cash_kb_col_income', 'Einnahme'),
            expense: await tr(ctx, 'cash_kb_col_expense', 'Ausgabe'),
            balance: await tr(ctx, 'cash_kb_col_balance', 'Bestand'),
            dayTotal: await tr(ctx, 'cash_kb_day_total', 'Tagessumme'),
            entered: await tr(ctx, 'cash_kb_entered', 'erfasst')
        };

        const rowsHtml = [];
        let curDay = null;
        let dayIn = 0, dayOut = 0;

        function closeDay() {
            if (curDay === null) return;
            rowsHtml.push(`<tr class="day">
                <td colspan="3">${esc(L.dayTotal)} ${esc(fmtDate(curDay))}</td>
                <td class="num">${esc(fmtMoney(dayIn))}</td>
                <td class="num">${esc(fmtMoney(dayOut))}</td>
                <td class="num">${esc(fmtMoney(running))}</td></tr>`);
            dayIn = 0; dayOut = 0;
        }

        for (const m of movements || []) {
            const doc = docs.get(m.recorderTable + '|' + m.recorderUID) || {};
            // Дата ОПЕРАЦИИ, а не дата ввода: см. шапку модуля.
            const opDate = doc.operationDate || m.period;
            const key = dayKey(opDate);
            if (curDay !== null && key !== dayKey(curDay)) closeDay();
            if (curDay === null || key !== dayKey(curDay)) curDay = opDate;

            const amount = money.num(m.amount);
            const isIn = Number(m.sign) > 0;
            if (isIn) { dayIn = money.add(dayIn, amount); running = money.add(running, amount); }
            else { dayOut = money.add(dayOut, amount); running = money.sub(running, amount); }

            const text = [doc.name, doc.comment].filter(Boolean).join(' — ') || m.comment || '';
            rowsHtml.push(`<tr>
                <td>${esc(fmtDate(opDate))}</td>
                <td>${esc(doc.number || '')}</td>
                <td>${esc(text)}<span class="entered">${doc.createdAt ? ' (' + esc(L.entered) + ' ' + esc(fmtDate(doc.createdAt)) + ')' : ''}</span></td>
                <td class="num">${isIn ? esc(fmtMoney(amount)) : ''}</td>
                <td class="num">${isIn ? '' : esc(fmtMoney(amount))}</td>
                <td class="num">${esc(fmtMoney(running))}</td></tr>`);
        }
        closeDay();

        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(L.title)}</title>
<style>
 body { font-family: "Segoe UI", Tahoma, sans-serif; font-size: 12px; color: #000; }
 h1 { font-size: 16px; margin: 0 0 4px 0; }
 .meta { margin-bottom: 10px; }
 table { border-collapse: collapse; width: 100%; }
 th, td { border: 1px solid #999; padding: 3px 5px; vertical-align: top; }
 th { background: #e0e0e0; text-align: left; }
 td.num, th.num { text-align: right; white-space: nowrap; }
 tr.day td { background: #f2f2f2; font-weight: bold; }
 .entered { color: #666; }
 .totals { margin-top: 10px; }
</style></head><body>
<h1>${esc(L.title)}</h1>
<div class="meta">${esc(L.period)}: ${esc(fmtDate(from))} — ${esc(fmtDate(to))}<br>
${esc(L.opening)}: ${esc(fmtMoney(opening))}</div>
<table>
 <thead><tr>
  <th>${esc(L.date)}</th><th>${esc(L.number)}</th><th>${esc(L.text)}</th>
  <th class="num">${esc(L.income)}</th><th class="num">${esc(L.expense)}</th><th class="num">${esc(L.balance)}</th>
 </tr></thead>
 <tbody>${rowsHtml.join('\n')}</tbody>
</table>
<div class="totals"><b>${esc(L.closing)}: ${esc(fmtMoney(running))}</b></div>
</body></html>`;

        return { ok: true, html, opening: money.db(opening), closing: money.db(running) };
    }

    return { build };
};
