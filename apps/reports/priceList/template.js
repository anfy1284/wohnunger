'use strict';

// ─────────────────────────────────────────────────────────────────────
// Шаблон HTML печатной формы документа «Прайс-лист» (только таблица).
//
// Воспроизводит бумажную сетку тарифов: строки — сезоны (название +
// список периодов из справочника seasons/season_periods), колонки —
// группы по комнатам, внутри группы — подколонки по числу гостей.
// Печатается РОВНО содержимое ТЧ проживания документа (WYSIWYG):
// порядок сезонов/комнат — порядок их первого появления в строках ТЧ,
// шаблон ничего не перегруппировывает и не дополняет.
//
// A4 landscape, без шапки письма и колонтитулов — по заданию только таблица.
// ─────────────────────────────────────────────────────────────────────

const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Генерация HTML печатной формы прайс-листа.
 * @param {object} opts
 * @param {object} opts.priceList        — запись price_lists (raw)
 * @param {Array}  opts.rows             — строки price_list_room_prices (raw, в порядке создания)
 * @param {object} opts.seasonsById      — { seasonId: запись seasons (raw) }
 * @param {object} opts.periodsBySeason  — { seasonId: [записи season_periods (raw)] }
 * @param {object} opts.roomsById        — { roomId: запись rooms (raw) }
 * @param {function} [opts.t]            — переводчик t(key) уже для нужного языка
 * @param {function} [opts.tf]           — переводчик с плейсхолдерами tf(key, vars)
 * @param {string} [opts.locale]         — локаль форматирования чисел (напр. 'de-DE')
 * @param {string} [opts.lang]           — код языка документа (для <html lang>)
 * @returns {string} HTML-документ
 */
function renderPriceListHTML({ priceList, rows, seasonsById, periodsBySeason, roomsById, t, tf, locale, lang }) {
    if (typeof t !== 'function') t = (k) => k;
    if (typeof tf !== 'function') tf = (k) => k;
    locale = locale || 'de-DE';
    lang   = lang || 'de';
    rows   = rows || [];

    const fmtNum = v => Number(v).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // Период — короткая дата dd.MM.yy. DATEONLY приходит строкой 'YYYY-MM-DD' —
    // парсим её напрямую (без new Date, чтобы не ловить сдвиг таймзоны).
    const fmtShort = v => {
        const s = String(v || '');
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return esc(s);
        return `${m[3]}.${m[2]}.${m[1].slice(2)}`;
    };

    // ── Структура сетки из строк ТЧ (порядок первого появления) ──────
    const seasonOrder = [];
    const roomOrder   = [];
    const guestsByRoom = {};   // roomId -> Set(guestsCount)
    const priceMap = {};       // `${seasonId}|${roomId}|${guests}` -> price
    for (const r of rows) {
        if (!r.seasonId || !r.roomId) continue;
        if (!seasonOrder.includes(r.seasonId)) seasonOrder.push(r.seasonId);
        if (!roomOrder.includes(r.roomId)) roomOrder.push(r.roomId);
        const g = Number(r.guestsCount);
        (guestsByRoom[r.roomId] = guestsByRoom[r.roomId] || new Set()).add(g);
        priceMap[`${r.seasonId}|${r.roomId}|${g}`] = r.price;
    }
    const guestCols = {};      // roomId -> [1, 2, ...] по возрастанию
    for (const roomId of roomOrder) {
        guestCols[roomId] = Array.from(guestsByRoom[roomId]).sort((a, b) => a - b);
    }

    // ── Шапка: 1-я строка — комнаты (colspan), 2-я — число гостей ────
    let headRooms = '<th class="corner" rowspan="2"></th>';
    let headGuests = '';
    for (const roomId of roomOrder) {
        const room = roomsById[roomId];
        const roomName = room ? (room.number || room.name || '') : '';
        headRooms += `<th class="room" colspan="${guestCols[roomId].length}">${esc(roomName)}</th>`;
        for (const g of guestCols[roomId]) {
            headGuests += `<th class="pers${g === guestCols[roomId][0] ? ' grp' : ''}">${esc(tf('price_list_print_persons', { n: g }))}</th>`;
        }
    }

    // ── Тело: строка на сезон — название + периоды, затем цены ───────
    let bodyHtml = '';
    for (const seasonId of seasonOrder) {
        const season = seasonsById[seasonId];
        const seasonName = season ? (season.name || '') : '';
        const periods = (periodsBySeason[seasonId] || [])
            .slice()
            .sort((a, b) => String(a.dateFrom).localeCompare(String(b.dateFrom)));
        const periodLines = periods
            .map(p => `<div class="period">${fmtShort(p.dateFrom)}&ndash;${fmtShort(p.dateTo)}</div>`)
            .join('');
        let cells = '';
        for (const roomId of roomOrder) {
            for (const g of guestCols[roomId]) {
                const price = priceMap[`${seasonId}|${roomId}|${g}`];
                const val = (price === undefined || price === null) ? '' : fmtNum(price) + '&nbsp;&euro;';
                cells += `<td class="price${g === guestCols[roomId][0] ? ' grp' : ''}">${val}</td>`;
            }
        }
        bodyHtml += `<tr><td class="season"><div class="season-name">${esc(seasonName)}</div>${periodLines}</td>${cells}</tr>\n`;
    }

    const docNum = priceList && priceList.number ? String(priceList.number) : '';

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8"/>
<title>${t('PriceList')} ${esc(docNum)}</title>
<style>
@page { size: A4 landscape; margin: 10mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 8pt; line-height: 1.2; color: #000; }

/* Превью: серый фон, лист-подложка. Печать: чистый лист. */
.sheet { background: #fff; width: 277mm; min-height: 190mm; margin: 0 auto; padding: 10mm; }
@media screen { body { background: #9a9a9a; padding: 6mm 0; }
                .sheet { box-shadow: 0 1px 6px rgba(0,0,0,.45); } }
@media print  { body { background: #fff; } .sheet { width: auto; min-height: 0; padding: 0; box-shadow: none; } }

table.pl-table { width: 100%; border-collapse: collapse; }
table.pl-table th, table.pl-table td { border: 0.5pt solid #000; padding: 1mm 0.8mm; }
table.pl-table thead { display: table-header-group; }
th.corner { min-width: 24mm; }
th.room { font-weight: bold; text-align: center; border-bottom: 1.5pt solid #000; }
th.pers { font-weight: normal; text-align: center; white-space: nowrap; }
td.season { vertical-align: top; white-space: nowrap; border-top: 1.5pt solid #000; }
.season-name { font-weight: bold; text-decoration: underline; margin-bottom: 0.5mm; }
.period { text-align: left; }
td.price { text-align: center; vertical-align: middle; white-space: nowrap; border-top: 1.5pt solid #000; }
/* Утолщённая линия между группами комнат */
th.grp, td.grp { border-left: 1.5pt solid #000; }
th.corner, th.room { border-left-width: 1.5pt; }
table.pl-table { border: 1.5pt solid #000; }
tr { page-break-inside: avoid; }
</style>
</head>
<body>
<div class="sheet">
<table class="pl-table">
<thead>
<tr>${headRooms}</tr>
<tr>${headGuests}</tr>
</thead>
<tbody>
${bodyHtml}</tbody>
</table>
</div>
</body>
</html>`;
}

module.exports = { renderPriceListHTML };
