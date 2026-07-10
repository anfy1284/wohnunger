'use strict';

// ─────────────────────────────────────────────────────────────────────
// Шаблон HTML-счёта (Rechnung) для печати.
// Получает данные бронирования и возвращает полный HTML-документ A4.
//
// Многостраничность: документ САМ пагинируется встроенным скриптом.
// Контент раскладывается по настоящим листам A4 (.page), на каждом листе
// повторяются шапка таблицы и нижний колонтитул с обязательными реквизитами
// (Pflichtangaben) + «Seite X von Y». Блок итогов и примечание не рвутся.
// Работает одинаково в превью (iframe, непрерывный скролл) и при печати.
// ─────────────────────────────────────────────────────────────────────

const esc     = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Группировка строк счёта для ПЕЧАТИ (представление, не учёт).
// Таблица invoice_lines хранит детализацию (по услуге, возрастной группе,
// налоговому компоненту) — это источник правды. Печатный документ показывает
// её свёрнутой. Классификация строк — структурная, по сохранённым полям:
//   • serviceId есть          → услуга: группируем по serviceId+taxComponent+taxRate
//                                в одну строку (label = sectionLabel — чистое имя
//                                услуги; для дроблёных по НДС услуг к имени дописываем
//                                имя компонента, напр. «Frühstück – Speisen»), сумма
//                                складывается. Завтрак с делёжкой НДС (Speisen 7% /
//                                Getränke 19%) остаётся ДВУМЯ строками — по компоненту,
//                                а не сводится к одной. Услуга без компонентов → одна строка.
//   • иначе bookingRoomId есть → проживание (Zimmer + дети): оставляем как есть.
//   • иначе                    → доп.строка (booking_extra_lines): оставляем как есть.
// Порядок: проживание (по убыванию суммы) → услуги (по убыванию суммы) → доп.строки
// (в исходном порядке). Ставка у каждой группы одна, поэтому свод MwSt по ставкам
// (taxGroups ниже) считается из этих же строк без расхождений.
function groupLinesForPrint(rawLines) {
    const r2 = v => Math.round(v * 100) / 100;
    const accommodation = [];
    const extra = [];
    const svcGroups = new Map(); // ключ: serviceId|taxComponentName|taxRate
    for (const ln of rawLines) {
        if (ln.serviceId) {
            const rate = ln.taxRate || 0;
            const comp = ln.taxComponentName || '';
            const key  = ln.serviceId + '|' + comp + '|' + rate;
            let g = svcGroups.get(key);
            if (!g) {
                const base = ln.sectionLabel || ln.label;
                g = { label: comp ? base + ' – ' + comp : base, taxRate: rate, amount: 0 };
                svcGroups.set(key, g);
            }
            g.amount = r2(g.amount + (Number(ln.amount) || 0));
        } else if (ln.bookingRoomId) {
            accommodation.push(ln);
        } else {
            extra.push(ln);
        }
    }
    accommodation.sort((a, b) => b.amount - a.amount);
    const services = Array.from(svcGroups.values()).sort((a, b) => b.amount - a.amount);
    return accommodation.concat(services, extra);
}

/**
 * Генерация HTML-документа счёта.
 * @param {object} opts
 * @param {object} opts.invoice   — запись из таблицы invoices (raw) — документ «Счёт»
 * @param {Array}  opts.bookings  — брони счёта (raw, в порядке ТЧ invoice_bookings)
 * @param {object|null} opts.client — запись из таблицы clients  (raw)
 * @param {object|null} opts.hotel  — запись из таблицы hotels   (raw)
 * @param {object|null} opts.org    — запись из таблицы organizations (raw)
 * @param {Array}  opts.lines      — строки InvoiceLines (raw, sorted by sortOrder)
 * @param {function} [opts.t]      — переводчик t(key) уже для нужного языка
 * @param {function} [opts.tf]     — переводчик с плейсхолдерами tf(key, vars)
 * @param {string} [opts.locale]  — локаль форматирования дат/чисел (напр. 'de-DE')
 * @param {string} [opts.lang]    — код языка документа (для <html lang>)
 * @returns {string} HTML-документ
 */
function renderInvoiceHTML({ invoice, bookings, client, hotel, org, lines, t, tf, locale, lang, invoiceNote }) {
    if (typeof t !== 'function') t = (k) => k;
    if (typeof tf !== 'function') tf = (k) => k;
    locale = locale || 'de-DE';
    lang   = lang || 'de';
    bookings = Array.isArray(bookings) ? bookings : [];
    const rawLines = lines || [];
    const fmtDate = d => { const dt = new Date(d); return dt.toLocaleDateString(locale); };
    const fmtNum  = (v, dec) => Number(v).toLocaleString(locale, { minimumFractionDigits: dec || 2, maximumFractionDigits: dec || 2 });

    // «Rechnung Nr.» = номер ДОКУМЕНТА счёта (invoices.number), дата — invoices.date.
    // invoice.name — представление (номер + клиент + дата), в печать не идёт.
    const invoiceNum  = invoice.number || invoice.UID.slice(0, 8);
    const invoiceDate = fmtDate(invoice.date || new Date());
    // Период проживания в шапке — по всем броням счёта (min заезд … max выезд).
    let minIn = null, maxOut = null;
    for (const b of bookings) {
        if (b.checkIn  && (!minIn  || new Date(b.checkIn)  < new Date(minIn)))  minIn  = b.checkIn;
        if (b.checkOut && (!maxOut || new Date(b.checkOut) > new Date(maxOut))) maxOut = b.checkOut;
    }
    const checkIn     = minIn  ? fmtDate(minIn)  : '';
    const checkOut    = maxOut ? fmtDate(maxOut) : '';
    const prepayment  = Number(invoice.prepayment) || 0;

    // Свёртка строк для печати: при НЕСКОЛЬКИХ бронях — посекционно (заголовок
    // «Buchung Nr. X, даты» + свёрнутые строки этой брони); строки без bookingId
    // (ручные) — в конце без заголовка. Одна бронь — как раньше, без секций.
    // Свод MwSt (taxGroups) считается из тех же свёрнутых строк.
    const sections = [];
    if (bookings.length > 1) {
        for (const b of bookings) {
            const own = rawLines.filter(ln => ln.bookingId === b.UID);
            if (!own.length) continue;
            sections.push({
                header: tf('invoice_booking_section', {
                    number: b.number || '', from: fmtDate(b.checkIn), to: fmtDate(b.checkOut)
                }),
                lines: groupLinesForPrint(own)
            });
        }
        const orphan = rawLines.filter(ln => !ln.bookingId || !bookings.some(b => b.UID === ln.bookingId));
        if (orphan.length) sections.push({ header: null, lines: groupLinesForPrint(orphan) });
    } else {
        sections.push({ header: null, lines: groupLinesForPrint(rawLines) });
    }
    const flatLines = sections.reduce((acc, s) => acc.concat(s.lines), []);

    // Суммы по ставкам MwSt
    let totalBrutto = 0;
    const taxGroups = {};
    for (const ln of flatLines) {
        totalBrutto += ln.amount;
        const rate = ln.taxRate || 0;
        if (!taxGroups[rate]) taxGroups[rate] = { brutto: 0, mwst: 0 };
        const mwst = Math.round(ln.amount * rate / (100 + rate) * 100) / 100;
        taxGroups[rate].brutto += ln.amount;
        taxGroups[rate].mwst   += mwst;
    }
    // totalNetto считаем как brutto - sum(mwst) чтобы избежать расхождений при округлении
    let totalMwSt = 0;
    for (const g of Object.values(taxGroups)) totalMwSt += g.mwst;
    totalMwSt = Math.round(totalMwSt * 100) / 100;
    const totalNetto = Math.round((totalBrutto - totalMwSt) * 100) / 100;

    // Строки таблицы услуг (с заголовками секций при нескольких бронях)
    let rowsHtml = '';
    for (const sec of sections) {
        if (sec.header) {
            rowsHtml += '<tr class="section-head"><td colspan="4">' + esc(sec.header) + '</td></tr>\n';
        }
        for (const ln of sec.lines) {
            const rate = ln.taxRate || 0;
            const mwst = Math.round(ln.amount * rate / (100 + rate) * 100) / 100;
            const mwstCell = rate === 0 ? '&ndash;' : fmtNum(mwst) + ' &euro;';
            rowsHtml += '<tr>'
                + '<td>' + esc(ln.label) + '</td>'
                + '<td class="num">' + rate + '%</td>'
                + '<td class="num">' + mwstCell + '</td>'
                + '<td class="num">' + fmtNum(ln.amount) + ' &euro;</td>'
                + '</tr>\n';
        }
    }

    // Итоговые строки по ставкам MwSt (нулевые ставки не отображаем)
    let taxSummaryHtml = '';
    const rates = Object.keys(taxGroups).sort((a, b) => Number(a) - Number(b));
    for (const rate of rates) {
        if (Number(rate) === 0) continue; // 0% не выводим — нет смысла
        const g = taxGroups[rate];
        taxSummaryHtml += '<tr class="tax-row">'
            + '<td colspan="3" class="num">' + t('invoice_of_which_vat') + ' ' + rate + '%</td>'
            + '<td class="num">' + fmtNum(g.mwst) + ' &euro;</td>'
            + '</tr>\n';
    }

    // Блок итогов (не должен рваться между листами)
    const totalsHtml =
        '<tr class="subtotal">'
        + '<td colspan="3" class="num">' + t('invoice_subtotal') + '</td>'
        + '<td class="num">' + fmtNum(totalBrutto) + ' &euro;</td>'
        + '</tr>\n'
        + '<tr class="tax-row">'
        + '<td colspan="3" class="num">' + t('invoice_net_amount') + '</td>'
        + '<td class="num">' + fmtNum(totalNetto) + ' &euro;</td>'
        + '</tr>\n'
        + taxSummaryHtml
        + '<tr class="grand-total">'
        + '<td colspan="3" class="num">' + t('invoice_total_amount') + '</td>'
        + '<td class="num">' + fmtNum(totalBrutto) + ' &euro;</td>'
        + '</tr>\n'
        + (prepayment > 0
            ? '<tr class="tax-row">'
              + '<td colspan="3" class="num">' + t('invoice_less_prepayment') + '</td>'
              + '<td class="num">&minus;' + fmtNum(prepayment) + ' &euro;</td>'
              + '</tr>\n'
              + '<tr class="grand-total">'
              + '<td colspan="3" class="num">' + t('invoice_balance_due') + '</td>'
              + '<td class="num">' + fmtNum(Math.round((totalBrutto - prepayment) * 100) / 100) + ' &euro;</td>'
              + '</tr>\n'
            : '');

    const clientName    = client ? esc(client.name) : '';
    const clientAddress = client && client.address ? esc(client.address).replace(/\n/g, '<br/>') : '';
    const hotelAddress  = hotel  && hotel.address ? esc(hotel.address) : '';
    const orgName       = org    ? esc(org.name)    : '';
    const orgAddress    = org    && org.address ? esc(org.address) : '';
    const orgPhone      = org    && org.phone  ? esc(org.phone)  : '';
    const orgFax        = org    && org.fax    ? esc(org.fax)    : '';
    const orgEmail      = org    && org.email  ? esc(org.email)  : '';
    const orgWebsite    = org    && org.website ? esc(org.website) : '';
    const orgTaxNumber  = org    && org.taxNumber ? esc(org.taxNumber) : '';
    const orgIban       = org    && org.iban   ? esc(org.iban)   : '';
    const orgBic        = org    && org.bic    ? esc(org.bic)    : '';

    // ── Колонтитул (Pflichtangaben), повторяется на каждом листе ──
    const footerInner =
        '<div class="ft-col ft-org">' + orgName + (orgAddress ? '<br/>' + orgAddress : '') + '</div>'
        + '<div class="ft-col ft-center">'
        + (orgTaxNumber ? t('invoice_tax_number_label') + ': ' + orgTaxNumber + '<br/>' : '')
        + '<span class="page-num"></span></div>'
        + '<div class="ft-col ft-bank">'
        + (orgIban ? 'IBAN:&nbsp;' + orgIban : '')
        + (orgBic ? '<br/>BIC:&nbsp;' + orgBic : '') + '</div>';

    // ── Бегущая шапка на листах со 2-го (повтор номера счёта/клиента) ──
    const runHeadInner =
        '<div class="rh-left"><strong>' + t('invoice_no_label') + ' ' + esc(invoiceNum) + '</strong></div>'
        + '<div class="rh-right">' + (clientName ? clientName + ' &middot; ' : '')
        + checkIn + ' &ndash; ' + checkOut + '</div>';

    // ── «Шапка письма» — только на первом листе ──
    const letterheadInner = `
<div class="header">
  <div class="logo-area">
    <img src="/apps/reports/resources/public/beim_seiler_4c_logo_2021.png" alt="${orgName}" /><br/>
  </div>
  <div class="contact">
    <span class="contact-name">${orgName}</span><br/>
    ${orgAddress ? orgAddress + '<br/>' : ''}${hotelAddress && hotelAddress !== orgAddress ? hotelAddress + '<br/>' : ''}
    ${orgPhone ? t('invoice_phone_label') + ': ' + orgPhone + '<br/>' : ''}
    ${orgFax ? t('invoice_fax_label') + ': ' + orgFax + '<br/>' : ''}
    ${orgEmail ? t('invoice_email_label') + ': ' + orgEmail + '<br/>' : ''}
    ${orgWebsite ? t('invoice_website_label') + ': ' + orgWebsite + '<br/>' : ''}
    ${orgTaxNumber ? t('invoice_tax_number_label') + ': ' + orgTaxNumber : ''}
  </div>
</div>

<div class="fold-mark"></div>

<div class="addr-block">
  <div class="addr-sender">${orgName}${orgAddress ? ', ' + orgAddress : ''}</div><br/>
  <strong>${clientName}</strong><br/>
  ${clientAddress}
</div>

<div class="inv-meta">
<table><tr>
  <td><strong>${t('invoice_date_label')}:</strong></td><td>${invoiceDate}</td>
  <td style="padding-left:10mm;"><strong>${t('invoice_period_label')}:</strong></td>
  <td>${checkIn} &ndash; ${checkOut}</td>
</tr></table>
</div>

<h2>${t('invoice_no_label')} ${esc(invoiceNum)}</h2>`;

    // Примечание к счёту — свободный текст из выбранного в брони варианта отчёта
    // (report_variants → invoiceNote). Печатается как есть, на языке ввода;
    // перевода нет. Переносы строк → <br/>. Пусто → блок примечания не выводится.
    const noteInner = invoiceNote
        ? esc(invoiceNote).replace(/\r?\n/g, '<br/>')
        : '';

    const colgroupHtml = '<colgroup>'
        + '<col class="col-desc"/><col class="col-rate"/><col class="col-mwst"/><col class="col-price"/>'
        + '</colgroup>';
    const theadHtml = '<thead><tr>'
        + '<th>' + t('invoice_col_description') + '</th>'
        + '<th class="num">' + t('invoice_col_vat_rate') + '</th>'
        + '<th class="num">' + t('invoice_col_vat') + '</th>'
        + '<th class="num">' + t('invoice_col_total') + '</th>'
        + '</tr></thead>';

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8"/>
<title>${t('invoice_title')} ${esc(invoiceNum)}</title>
<style>
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 9pt; line-height: 1.25; color: #000; }

/* Лист A4 */
.page { width: 210mm; height: 297mm; padding: 15mm 20mm;
        display: flex; flex-direction: column; overflow: hidden;
        background: #fff; position: relative; }
.page-body   { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.page-footer { flex: 0 0 auto; margin-top: 4mm; padding-top: 3mm;
               border-top: 0.5pt solid #999; font-size: 8pt; color: #000;
               display: flex; justify-content: space-between; gap: 4mm; }
.page-footer .ft-col { flex: 1; }
.page-footer .ft-center { text-align: center; }
.page-footer .ft-bank   { text-align: right; white-space: nowrap; }
.page-footer .page-num  { color: #000; }

/* Превью: серый фон, тени-листы. Печать: чистые листы с разрывом. */
@media screen { body { background: #9a9a9a; }
                .page { margin: 0 auto 6mm; box-shadow: 0 1px 6px rgba(0,0,0,.45); } }
@media print  { body { background: #fff; }
                .page { margin: 0; box-shadow: none; }
                .page:not(:last-child) { break-after: page; page-break-after: always; } }

/* Шапка письма (1-й лист) */
.header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 3mm; }
.header .logo-area { max-width: 320px; }
.header .logo-area img { max-width: 300px; }
.header .contact { text-align: right; font-size: 8.5pt; line-height: 1.45; }
.header .contact .contact-name { font-weight: bold; font-size: 9pt; }
.fold-mark { border-top: 1px solid #ccc; margin: 0 0 5mm 0; }
.addr-block { font-size: 10pt; min-height: 18mm; margin-bottom: 4mm; }
.addr-sender { font-size: 7pt; margin-bottom: 2mm;
               border-bottom: 0.5pt solid #888; display: inline-block; padding-bottom: 1px; }
.inv-meta { margin-bottom: 4mm; }
.inv-meta table td { padding: 0.6mm 4mm 0.6mm 0; }
h2 { font-size: 12pt; margin: 2.5mm 0; }

/* Бегущая шапка (листы со 2-го) */
.run-head { display: flex; justify-content: space-between; align-items: baseline;
            font-size: 8.5pt; color: #333; border-bottom: 0.3pt solid #bbb;
            padding-bottom: 1.5mm; margin-bottom: 5mm; }

/* Таблица услуг */
table.inv-table { width: 100%; border-collapse: collapse; margin: 0 0 3mm 0; table-layout: fixed; }
table.inv-table colgroup col.col-desc  { width: 58%; }
table.inv-table colgroup col.col-rate  { width: 13%; }
table.inv-table colgroup col.col-mwst  { width: 13%; }
table.inv-table colgroup col.col-price { width: 16%; }
table.inv-table th { text-align: left; font-weight: bold; padding: 1.4mm 2.5mm;
                     border-bottom: 1.5pt solid #000; white-space: nowrap; overflow: hidden; }
table.inv-table th.num { text-align: right; }
table.inv-table td { padding: 1.1mm 2.5mm; border-bottom: 0.3pt solid #ccc; vertical-align: top; }
table.inv-table td.num { text-align: right; white-space: nowrap; }
tr.subtotal td { border-top: 1pt solid #000; font-weight: bold; padding-top: 2.5mm; }
tr.tax-row td { border-bottom: none; font-size: 9pt; }
tr.grand-total td { border-top: 1.5pt solid #000; border-bottom: none; font-weight: bold; font-size: 11pt; }
tr.section-head td { font-weight: bold; padding-top: 3mm; border-bottom: 0.5pt solid #888; }

.note { margin-top: 8mm; font-size: 9pt; }
</style>
</head>
<body>

<!-- Источник контента (скрыт): пагинатор разложит его по листам -->
<div id="src-wrap" style="display:none">
  <div id="src-letterhead">${letterheadInner}</div>
  <table id="src-table" class="inv-table">
    ${colgroupHtml}
    ${theadHtml}
    <tbody class="lines">
${rowsHtml}    </tbody>
    <tbody class="totals">
${totalsHtml}    </tbody>
  </table>
  <div id="src-note" class="note">${noteInner}</div>
  <div id="src-footer">${footerInner}</div>
  <div id="src-runhead">${runHeadInner}</div>
</div>

<div id="pages"></div>

<script>
(function () {
  function paginate() {
    var src = document.getElementById('src-wrap');
    if (!src) return;
    var pagesRoot = document.getElementById('pages');
    var srcTable  = document.getElementById('src-table');
    var colgroupHTML = srcTable.querySelector('colgroup').outerHTML;
    var theadHTML    = srcTable.querySelector('thead').outerHTML;
    var lineRows  = Array.prototype.slice.call(srcTable.querySelector('tbody.lines').children);
    var totalRows = Array.prototype.slice.call(srcTable.querySelector('tbody.totals').children);
    var letterhead = document.getElementById('src-letterhead');
    var noteEl     = document.getElementById('src-note');
    var footerHTML = document.getElementById('src-footer').innerHTML;
    var runHeadHTML= document.getElementById('src-runhead').innerHTML;

    function makePage(first) {
      var page = document.createElement('div'); page.className = 'page';
      var body = document.createElement('div'); body.className = 'page-body';
      if (first) {
        var lh = document.createElement('div');
        lh.innerHTML = letterhead.innerHTML;
        body.appendChild(lh);
      } else {
        var rh = document.createElement('div'); rh.className = 'run-head';
        rh.innerHTML = runHeadHTML;
        body.appendChild(rh);
      }
      var footer = document.createElement('div'); footer.className = 'page-footer';
      footer.innerHTML = footerHTML;
      page.appendChild(body); page.appendChild(footer);
      pagesRoot.appendChild(page);
      return body;
    }
    function newTable(body) {
      var t = document.createElement('table'); t.className = 'inv-table';
      t.innerHTML = colgroupHTML + theadHTML + '<tbody class="lines"></tbody>';
      body.appendChild(t);
      return t.querySelector('tbody.lines');
    }
    function fits(body) { return body.scrollHeight <= body.clientHeight + 1; }

    var body = makePage(true);
    var tbody = newTable(body);

    // 1. Строки услуг
    for (var i = 0; i < lineRows.length; i++) {
      var row = lineRows[i];
      tbody.appendChild(row);
      if (!fits(body)) {
        tbody.removeChild(row);
        body = makePage(false);
        tbody = newTable(body);
        tbody.appendChild(row); // на свежем листе помещается (иначе оставляем как есть)
      }
    }

    // 2. Блок итогов — единым куском, не рвём
    var totalsTbody = document.createElement('tbody'); totalsTbody.className = 'totals';
    for (var j = 0; j < totalRows.length; j++) totalsTbody.appendChild(totalRows[j]);
    tbody.parentNode.appendChild(totalsTbody);
    if (!fits(body)) {
      tbody.parentNode.removeChild(totalsTbody);
      body = makePage(false);
      tbody = newTable(body);
      tbody.parentNode.appendChild(totalsTbody);
    }

    // 3. Примечание
    if (noteEl) {
      var note = document.createElement('div'); note.className = 'note';
      note.innerHTML = noteEl.innerHTML;
      body.appendChild(note);
      if (!fits(body)) {
        body.removeChild(note);
        body = makePage(false);
        body.appendChild(note);
      }
    }

    // 4. Нумерация листов «Seite X von Y»
    var pages = pagesRoot.querySelectorAll('.page');
    for (var p = 0; p < pages.length; p++) {
      var el = pages[p].querySelector('.page-num');
      if (el) el.textContent = ${JSON.stringify(t('invoice_page_label'))} + ' ' + (p + 1) + ' ' + ${JSON.stringify(t('invoice_page_of'))} + ' ' + pages.length;
    }

    src.parentNode.removeChild(src);
  }

  if (document.readyState === 'complete') paginate();
  else window.addEventListener('load', paginate);
})();
</script>

</body>
</html>`;
}

module.exports = { renderInvoiceHTML };
