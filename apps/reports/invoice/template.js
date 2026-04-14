'use strict';

// ─────────────────────────────────────────────────────────────────────
// Шаблон HTML-счёта (Rechnung) для печати.
// Получает данные бронирования и возвращает полный HTML-документ A4.
// ─────────────────────────────────────────────────────────────────────

const fmtDate = d => { const dt = new Date(d); return dt.toLocaleDateString('de-DE'); };
const fmtNum  = (v, dec) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: dec || 2, maximumFractionDigits: dec || 2 });
const esc     = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Генерация HTML-документа счёта.
 * @param {object} opts
 * @param {object} opts.booking    — запись из таблицы bookings (raw)
 * @param {object|null} opts.client — запись из таблицы clients  (raw)
 * @param {object|null} opts.hotel  — запись из таблицы hotels   (raw)
 * @param {object|null} opts.org    — запись из таблицы organizations (raw)
 * @param {Array}  opts.lines      — строки InvoiceLines (raw, sorted by sortOrder)
 * @returns {string} HTML-документ
 */
function renderInvoiceHTML({ booking, client, hotel, org, lines }) {
    const invoiceNum  = booking.name || booking.UID.slice(0, 8);
    const invoiceDate = fmtDate(new Date());
    const checkIn     = fmtDate(booking.checkIn);
    const checkOut    = fmtDate(booking.checkOut);

    // Суммы по ставкам MwSt
    let totalBrutto = 0;
    const taxGroups = {};
    for (const ln of lines) {
        totalBrutto += ln.amount;
        const rate = ln.taxRate || 0;
        if (!taxGroups[rate]) taxGroups[rate] = { brutto: 0, mwst: 0, netto: 0 };
        const mwst = ln.amount * rate / (100 + rate);
        taxGroups[rate].brutto += ln.amount;
        taxGroups[rate].mwst   += mwst;
        taxGroups[rate].netto  += ln.amount - mwst;
    }
    let totalNetto = 0;
    for (const g of Object.values(taxGroups)) totalNetto += g.netto;

    // Строки таблицы
    let rowsHtml = '';
    for (const ln of lines) {
        const mwst = ln.amount * (ln.taxRate || 0) / (100 + (ln.taxRate || 0));
        rowsHtml += '<tr>'
            + '<td>' + esc(ln.label) + '</td>'
            + '<td class="num">' + (ln.taxRate || 0) + '%</td>'
            + '<td class="num">' + fmtNum(mwst) + ' &euro;</td>'
            + '<td class="num">' + fmtNum(ln.amount) + ' &euro;</td>'
            + '</tr>\n';
    }

    // Итоговые строки по ставкам MwSt
    let taxSummaryHtml = '';
    const rates = Object.keys(taxGroups).sort((a, b) => Number(a) - Number(b));
    for (const rate of rates) {
        const g = taxGroups[rate];
        taxSummaryHtml += '<tr class="tax-row">'
            + '<td colspan="3" class="num">davon MwSt. ' + rate + '%</td>'
            + '<td class="num">' + fmtNum(g.mwst) + ' &euro;</td>'
            + '</tr>\n';
    }

    const clientName    = client ? esc(client.name) : '';
    const clientAddress = client && client.address ? esc(client.address).replace(/\n/g, '<br/>') : '';
    const hotelName     = hotel  ? esc(hotel.name)  : '';
    const hotelAddress  = hotel  && hotel.address ? esc(hotel.address) : '';
    const orgName       = org    ? esc(org.name)    : '';
    const orgAddress    = org    && org.address ? esc(org.address) : '';
    const orgPhone      = org    && org.phone  ? esc(org.phone)  : '';
    const orgEmail      = org    && org.email  ? esc(org.email)  : '';
    const orgTaxNumber  = org    && org.taxNumber ? esc(org.taxNumber) : '';
    const orgIban       = org    && org.iban   ? esc(org.iban)   : '';
    const orgBic        = org    && org.bic    ? esc(org.bic)    : '';

    return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8"/>
<title>Rechnung ${esc(invoiceNum)}</title>
<style>
@page { size: A4; margin: 15mm 20mm; }
* { box-sizing: border-box; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #000;
       margin: 0; padding: 15mm 20mm; }
.header { display: flex; justify-content: space-between; align-items: flex-start;
          margin-bottom: 10mm; }
.header .logo-area { max-width: 220px; }
.header .logo-area img { max-width: 200px; }
.header .contact { text-align: right; font-size: 8.5pt; color: #444; line-height: 1.5; }
.fold-mark { border-top: 1px solid #ccc; margin: 2mm 0 8mm 0; }
.addr-block { font-size: 10pt; min-height: 25mm; margin-bottom: 5mm; }
.addr-sender { font-size: 7pt; color: #888; margin-bottom: 2mm;
               border-bottom: 0.5pt solid #888; display: inline-block; padding-bottom: 1px; }
.inv-meta { margin-bottom: 6mm; }
.inv-meta table td { padding: 1mm 4mm 1mm 0; }
h2 { font-size: 13pt; margin: 4mm 0; }
table.inv-table { width: 100%; border-collapse: collapse; margin: 3mm 0; }
table.inv-table th { text-align: left; font-weight: bold; padding: 2mm 3mm;
                     border-bottom: 1.5pt solid #000; }
table.inv-table th.num { text-align: right; }
table.inv-table td { padding: 2mm 3mm; border-bottom: 0.3pt solid #ccc; }
table.inv-table td.num { text-align: right; }
tr.subtotal td { border-top: 1pt solid #000; font-weight: bold; }
tr.tax-row td { border-bottom: none; font-size: 9pt; color: #333; }
tr.grand-total td { border-top: 1.5pt solid #000; font-weight: bold; font-size: 11pt; }
.footer { margin-top: 15mm; padding-top: 3mm; border-top: 0.5pt solid #999;
          font-size: 8pt; color: #555; display: flex; justify-content: space-between; }
.footer div { flex: 1; }
.note { margin-top: 8mm; font-size: 9pt; }
@media print { body { padding: 0; } }
</style>
</head>
<body>

<div class="header">
  <div class="logo-area">
    <img src="/apps/reports/resources/public/beim_seiler_4c_logo_2021.png" alt="${orgName}" style="max-width:200px;" /><br/>
  </div>
  <div class="contact">
    ${orgAddress ? orgAddress + '<br/>' : ''}${hotelAddress && hotelAddress !== orgAddress ? hotelAddress + '<br/>' : ''}
    ${orgPhone ? 'Tel.: ' + orgPhone + '<br/>' : ''}
    ${orgEmail ? 'E-Mail: ' + orgEmail : ''}
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
  <td><strong>Rechnungsdatum:</strong></td><td>${invoiceDate}</td>
  <td style="padding-left:10mm;"><strong>Zeitraum:</strong></td>
  <td>${checkIn} &ndash; ${checkOut}</td>
</tr></table>
</div>

<h2>Rechnung Nr. ${esc(invoiceNum)}</h2>

<table class="inv-table">
<thead>
  <tr>
    <th>Leistung / Beschreibung</th>
    <th class="num">MwSt.-Satz</th>
    <th class="num">MwSt.</th>
    <th class="num">Gesamtpreis</th>
  </tr>
</thead>
<tbody>
${rowsHtml}
  <tr class="subtotal">
    <td colspan="3" class="num">Zwischensumme</td>
    <td class="num">${fmtNum(totalBrutto)} &euro;</td>
  </tr>
  <tr class="tax-row">
    <td colspan="3" class="num">Nettobetrag</td>
    <td class="num">${fmtNum(totalNetto)} &euro;</td>
  </tr>
${taxSummaryHtml}
  <tr class="grand-total">
    <td colspan="3" class="num">Gesamtbetrag</td>
    <td class="num">${fmtNum(totalBrutto)} &euro;</td>
  </tr>
</tbody>
</table>

<div class="note">
Wir danken f&uuml;r Ihren Aufenthalt und w&uuml;nschen Ihnen eine gute Heimreise.<br/>
Bitte &uuml;berweisen Sie den Rechnungsbetrag innerhalb von 14 Tagen.
</div>

<div class="footer">
  <div>${orgName}${orgAddress ? '<br/>' + orgAddress : ''}</div>
  <div style="text-align:center;">${orgTaxNumber ? 'Steuernr.: ' + orgTaxNumber : ''}</div>
  <div style="text-align:right;">${orgIban ? 'IBAN: ' + orgIban : ''}${orgBic ? '<br/>BIC: ' + orgBic : ''}</div>
</div>

</body>
</html>`;
}

module.exports = { renderInvoiceHTML };
