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

// Печать БЕЗ повторной группировки: ТЧ счёта хранит строки уже в «печатном»
// виде (WYSIWYG — свёртку делает fillInvoice/prepareFromBooking в apps/invoice,
// см. _collapseInvoiceLines). Что пользователь видит и правит в форме счёта,
// то и печатается, строка в строку (порядок — sortOrder).

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
 * @param {object} [opts.taxCategories] — { [UID]: { name, invoiceNote } } налоговые
 *        категории строк счёта, УЖЕ на языке документа. `invoiceNote` — основание
 *        ставки (§ 14 Abs. 4 Nr. 8 UStG): печатается сноской под сводом НДС.
 * @returns {string} HTML-документ
 */
function renderInvoiceHTML({ invoice, bookings, client, hotel, org, lines, t, tf, locale, lang, invoiceNote, taxCategories }) {
    if (typeof t !== 'function') t = (k) => k;
    if (typeof tf !== 'function') tf = (k) => k;
    locale = locale || 'de-DE';
    lang   = lang || 'de';
    bookings = Array.isArray(bookings) ? bookings : [];
    const rawLines = lines || [];
    // Даты в юридическом документе — всегда с ведущими нулями (ДД.ММ.ГГГГ для de),
    // иначе toLocaleDateString даёт «20.7.2026».
    const fmtDate = d => new Date(d).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const fmtNum  = (v, dec) => Number(v).toLocaleString(locale, { minimumFractionDigits: dec || 2, maximumFractionDigits: dec || 2 });
    // Количество (Menge): целое печатается без дробной части, дробное — до 2 знаков.
    const fmtQty  = v => {
        const n = Number(v);
        if (!isFinite(n)) return '';
        return Number.isInteger(n) ? n.toLocaleString(locale) : fmtNum(n);
    };

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
    // Срок оплаты (invoices.dueDate) — не реквизит § 14 UStG, но если задан, он
    // обязан попасть в печать (иначе введённые данные теряются).
    const dueDate     = invoice.dueDate ? fmtDate(invoice.dueDate) : '';

    // Строки печатаются КАК ХРАНЯТСЯ (WYSIWYG). При НЕСКОЛЬКИХ бронях —
    // посекционно (заголовок «Buchung Nr. X, даты» + строки этой брони);
    // строки без bookingId (ручные) — в конце без заголовка. Одна бронь — без секций.
    // Свод MwSt (taxGroups) считается из тех же строк.
    const sections = [];
    if (bookings.length > 1) {
        for (const b of bookings) {
            const own = rawLines.filter(ln => ln.bookingId === b.UID);
            if (!own.length) continue;
            sections.push({
                header: tf('invoice_booking_section', {
                    number: b.number || '', from: fmtDate(b.checkIn), to: fmtDate(b.checkOut)
                }),
                lines: own
            });
        }
        const orphan = rawLines.filter(ln => !ln.bookingId || !bookings.some(b => b.UID === ln.bookingId));
        if (orphan.length) sections.push({ header: null, lines: orphan });
    } else {
        sections.push({ header: null, lines: rawLines });
    }
    const flatLines = sections.reduce((acc, s) => acc.concat(s.lines), []);

    // Суммы по ставкам MwSt (брутто ДО скидки — Zwischensumme).
    // Вместе со ставкой копим налоговые категории строк — из них берутся
    // основания ставки для сносок (данные, не текст шаблона).
    let subtotalBrutto = 0;
    const taxGroups = {};
    for (const ln of flatLines) {
        subtotalBrutto += ln.amount;
        const rate = ln.taxRate || 0;
        if (!taxGroups[rate]) taxGroups[rate] = { brutto: 0, mwst: 0, cats: new Set() };
        taxGroups[rate].brutto += ln.amount;
        if (ln.taxCategoryId) taxGroups[rate].cats.add(ln.taxCategoryId);
    }
    subtotalBrutto = Math.round(subtotalBrutto * 100) / 100;

    // Скидка на общую сумму (документальный реквизит invoices.discountMode/Value):
    // процент или абсолют. Раскладывается ПРОПОРЦИОНАЛЬНО брутто каждой налоговой
    // группы (k = скидочный/исходный брутто), поэтому НДС по группам пересчитывается
    // корректно. Копеечный дрейф распределения гасим в крупнейшую группу.
    const discMode = invoice.discountMode || 'percent';
    const discInput = Number(invoice.discountValue) || 0;
    let discount = (discMode === 'percent')
        ? Math.round(subtotalBrutto * discInput / 100 * 100) / 100
        : Math.round(discInput * 100) / 100;
    if (discount < 0) discount = 0;
    if (discount > subtotalBrutto) discount = subtotalBrutto; // итог не уходит в минус
    const discPctLabel = discInput.toLocaleString(locale, { maximumFractionDigits: 2 });

    const discountedBrutto = Math.round((subtotalBrutto - discount) * 100) / 100;
    const k = subtotalBrutto > 0 ? discountedBrutto / subtotalBrutto : 0;

    const rateKeys = Object.keys(taxGroups);
    let allocSum = 0, maxRate = null;
    for (const rate of rateKeys) {
        const g = taxGroups[rate];
        g.bruttoDisc = Math.round(g.brutto * k * 100) / 100;
        allocSum = Math.round((allocSum + g.bruttoDisc) * 100) / 100;
        if (maxRate === null || g.brutto > taxGroups[maxRate].brutto) maxRate = rate;
    }
    if (maxRate !== null) {
        const drift = Math.round((discountedBrutto - allocSum) * 100) / 100;
        if (drift !== 0) taxGroups[maxRate].bruttoDisc = Math.round((taxGroups[maxRate].bruttoDisc + drift) * 100) / 100;
    }

    // НДС и НЕТТО по группам — из скидочного брутто.
    // Нетто по КАЖДОЙ ставке — обязательный реквизит § 14 Abs. 4 Nr. 8 UStG
    // («nach Steuersätzen aufgeschlüsseltes Entgelt»), печатается в своде ниже.
    let totalMwSt = 0;
    for (const rate of rateKeys) {
        const g = taxGroups[rate];
        const r = Number(rate);
        g.mwst   = Math.round(g.bruttoDisc * r / (100 + r) * 100) / 100;
        g.netto  = Math.round((g.bruttoDisc - g.mwst) * 100) / 100;
        totalMwSt += g.mwst;
    }
    totalMwSt = Math.round(totalMwSt * 100) / 100;
    const totalNetto = Math.round((discountedBrutto - totalMwSt) * 100) / 100;

    // Строки таблицы услуг (с заголовками секций при нескольких бронях).
    // Колонки: Pos | Bezeichnung | Menge | Einzelpreis | MwSt-Satz | Gesamtpreis.
    // «Menge und Art der Leistung» (§ 14 Abs. 4 Nr. 5 UStG) — количество и цена
    // за единицу печатаются отдельными реквизитами, а не только внутри текста.
    let rowsHtml = '';
    let pos = 0;
    for (const sec of sections) {
        if (sec.header) {
            rowsHtml += '<tr class="section-head"><td colspan="6">' + esc(sec.header) + '</td></tr>\n';
        }
        for (const ln of sec.lines) {
            pos++;
            const rate = ln.taxRate || 0;
            const qty  = Number(ln.quantity);
            const unit = Number(ln.unitPrice);
            rowsHtml += '<tr>'
                + '<td class="num pos">' + pos + '</td>'
                + '<td>' + esc(ln.label) + '</td>'
                + '<td class="num">' + (isFinite(qty)  ? fmtQty(qty) : '') + '</td>'
                + '<td class="num">' + (isFinite(unit) ? fmtNum(unit) + ' &euro;' : '') + '</td>'
                + '<td class="num">' + rate + '&nbsp;%</td>'
                + '<td class="num">' + fmtNum(ln.amount) + ' &euro;</td>'
                + '</tr>\n';
        }
    }

    // ── Итоговый блок (правая колонка под таблицей услуг) ────────────────
    // Итоги и свод НДС — НЕ строки таблицы услуг, а отдельный правый блок
    // фиксированной ширины: разделительные линии идут только под цифрами,
    // а не через весь лист. Печатается единым куском (см. пагинатор).
    // Здесь — только денежное течение: брутто → скидка → итог → предоплата;
    // нетто/НДС по ставкам — в своде ниже.
    const sumRow = (cls, label, value) =>
        '<tr class="' + cls + '"><td class="lbl">' + label + '</td>'
        + '<td class="val">' + value + '</td></tr>\n';

    // Промежуточный итог печатаем только при наличии скидки — без неё он
    // дублировал бы Gesamtbetrag. Если строк над итогом нет, Gesamtbetrag
    // «прирастает» к таблице услуг: чёрной становится нижняя граница самой
    // таблицы, а собственная короткая линия итога убирается (класс t-first
    // + класс `joined` на блоке, который проставляет пагинатор).
    const hasRowsAboveTotal = discount > 0;
    const totalsHtml = '<table class="totals-table">\n'
        + (hasRowsAboveTotal
            ? sumRow('t-sub', t('invoice_subtotal'), fmtNum(subtotalBrutto) + ' &euro;')
              + sumRow('t-line',
                    t('invoice_discount') + (discMode === 'percent' ? ' (' + discPctLabel + '%)' : ''),
                    '&minus;' + fmtNum(discount) + ' &euro;')
            : '')
        + sumRow('t-grand' + (hasRowsAboveTotal ? '' : ' t-first'),
                 t('invoice_total_amount'), fmtNum(discountedBrutto) + ' &euro;')
        + (prepayment > 0
            ? sumRow('t-line', t('invoice_less_prepayment'), '&minus;' + fmtNum(prepayment) + ' &euro;')
              + sumRow('t-grand', t('invoice_balance_due'),
                    fmtNum(Math.round((discountedBrutto - prepayment) * 100) / 100) + ' &euro;')
            : '')
        + '</table>';

    // ── Свод по ставкам НДС (§ 14 Abs. 4 Nr. 8 UStG) ─────────────────────
    // Нетто (Entgelt), НДС и брутто — ОТДЕЛЬНОЙ строкой на каждую ставку,
    // включая 0% (требование «nach Steuersätzen UND Steuerbefreiungen
    // aufgeschlüsselt»). Итоговая строка сверяется с общими суммами документа.
    // Сноски-основания: собираем ТЕКСТЫ из категорий, реально встретившихся в
    // строках, и нумеруем в порядке появления. Одна ставка может нести несколько
    // оснований (напр. 0% = курсбор + освобождение § 4 Nr. 12a) — тогда у неё
    // будет несколько маркеров.
    const cats = taxCategories || {};
    const footnotes = [];          // тексты по порядку
    const footnoteIdx = new Map(); // текст → номер (1-based)
    const noteNumFor = (catId) => {
        const c = cats[catId];
        const txt = c && c.invoiceNote ? String(c.invoiceNote).trim() : '';
        if (!txt) return 0;
        if (!footnoteIdx.has(txt)) { footnotes.push(txt); footnoteIdx.set(txt, footnotes.length); }
        return footnoteIdx.get(txt);
    };

    const rates = Object.keys(taxGroups).sort((a, b) => Number(a) - Number(b));
    let vatRowsHtml = '';
    for (const rate of rates) {
        const g = taxGroups[rate];
        const marks = [...g.cats].map(noteNumFor).filter(Boolean).sort((a, b) => a - b);
        const sup = marks.length ? '<sup>' + marks.join(',&nbsp;') + '</sup>' : '';
        vatRowsHtml += '<tr>'
            + '<td class="num">' + rate + '&nbsp;%' + sup + '</td>'
            + '<td class="num">' + fmtNum(g.netto) + ' &euro;</td>'
            + '<td class="num">' + (Number(rate) === 0 ? '&ndash;' : fmtNum(g.mwst) + ' &euro;') + '</td>'
            + '<td class="num">' + fmtNum(g.bruttoDisc) + ' &euro;</td>'
            + '</tr>\n';
    }
    const footnotesHtml = footnotes.length
        ? '<div class="vat-note">'
          + footnotes.map((txt, i) => '<div><sup>' + (i + 1) + '</sup> ' + esc(txt) + '</div>').join('')
          + '</div>'
        : '';
    const vatSummaryHtml = rates.length
        ? '<div class="vat-summary">'
          + '<div class="vs-title">' + t('invoice_vat_breakdown_title') + '</div>'
          + '<table><thead><tr>'
          + '<th class="num">' + t('invoice_col_vat_rate') + '</th>'
          + '<th class="num">' + t('invoice_col_net') + '</th>'
          + '<th class="num">' + t('invoice_col_vat') + '</th>'
          + '<th class="num">' + t('invoice_col_gross') + '</th>'
          + '</tr></thead><tbody>\n' + vatRowsHtml
          + '<tr class="vs-total">'
          + '<td class="num">' + t('invoice_sum_label') + '</td>'
          + '<td class="num">' + fmtNum(totalNetto) + ' &euro;</td>'
          + '<td class="num">' + fmtNum(totalMwSt) + ' &euro;</td>'
          + '<td class="num">' + fmtNum(discountedBrutto) + ' &euro;</td>'
          + '</tr>\n</tbody></table></div>'
        : '';

    // Итоги + свод НДС в одном правом блоке; сноски-основания — во всю
    // ширину под ним (длинный текст в узкой колонке не читается).
    const summaryInner =
        '<div class="summary">' + totalsHtml + vatSummaryHtml + '</div>' + footnotesHtml;

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
<table>
<tr>
  <td><strong>${t('invoice_date_label')}:</strong></td><td>${invoiceDate}</td>
  <td class="meta-gap"><strong>${t('invoice_period_label')}:</strong></td>
  <td>${checkIn} &ndash; ${checkOut}</td>
</tr>
${dueDate ? `<tr>
  <td><strong>${t('invoice_due_date_label')}:</strong></td><td>${dueDate}</td>
  <td colspan="2"></td>
</tr>` : ''}
</table>
</div>

<h2>${t('invoice_no_label')} ${esc(invoiceNum)}</h2>`;

    // Примечание к счёту — свободный текст из выбранного в брони варианта отчёта
    // (report_variants → invoiceNote). Печатается как есть, на языке ввода;
    // перевода нет. Переносы строк → <br/>. Пусто → блок примечания не выводится.
    const noteInner = invoiceNote
        ? esc(invoiceNote).replace(/\r?\n/g, '<br/>')
        : '';

    const colgroupHtml = '<colgroup>'
        + '<col class="col-pos"/><col class="col-desc"/><col class="col-qty"/>'
        + '<col class="col-unit"/><col class="col-rate"/><col class="col-price"/>'
        + '</colgroup>';
    const theadHtml = '<thead><tr>'
        + '<th class="num">' + t('invoice_col_pos') + '</th>'
        + '<th>' + t('invoice_col_description') + '</th>'
        + '<th class="num">' + t('invoice_col_qty') + '</th>'
        + '<th class="num">' + t('invoice_col_unit_price') + '</th>'
        + '<th class="num">' + t('invoice_col_vat_rate') + '</th>'
        + '<th class="num">' + t('invoice_col_total') + '</th>'
        + '</tr></thead>';

    // ── Контроль обязательных реквизитов (§ 14 UStG) ─────────────────────
    // Печатная форма — юридический документ. Если в данных не хватает
    // обязательного реквизита, счёт дефектен (получатель не сможет заявить
    // вычет). Показываем предупреждение ТОЛЬКО на экране предпросмотра
    // (@media print — скрыто), чтобы оператор увидел проблему до печати.
    // Жёсткий запрет печати — задача формы счёта (apps/invoice), не шаблона.
    const KLEINBETRAG_LIMIT = 250; // § 33 UStDV: до 250 € брутто адрес получателя не обязателен
    const missing = [];
    if (!orgName)      missing.push(t('invoice_missing_org_name'));
    if (!orgAddress)   missing.push(t('invoice_missing_org_address'));
    if (!orgTaxNumber) missing.push(t('invoice_missing_tax_number'));
    if (!clientName)   missing.push(t('invoice_missing_client_name'));
    if (!clientAddress && discountedBrutto > KLEINBETRAG_LIMIT) missing.push(t('invoice_missing_client_address'));
    if (!invoice.number) missing.push(t('invoice_missing_number'));
    const warningHtml = missing.length
        ? '<div class="compliance-warning"><h3>' + t('invoice_missing_data_title') + '</h3><ul>'
          + missing.map(m => '<li>' + m + '</li>').join('')
          + '</ul><div class="cw-hint">' + t('invoice_missing_data_hint') + '</div></div>'
        : '';

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
.inv-meta table td.meta-gap { padding-left: 10mm; }
h2 { font-size: 12pt; margin: 2.5mm 0; }

/* Бегущая шапка (листы со 2-го) */
.run-head { display: flex; justify-content: space-between; align-items: baseline;
            font-size: 8.5pt; color: #333; border-bottom: 0.3pt solid #bbb;
            padding-bottom: 1.5mm; margin-bottom: 5mm; }

/* Таблица услуг */
table.inv-table { width: 100%; border-collapse: collapse; margin: 0 0 3mm 0; table-layout: fixed; }
table.inv-table colgroup col.col-pos   { width: 6%; }
table.inv-table colgroup col.col-desc  { width: 42%; }
table.inv-table colgroup col.col-qty   { width: 9%; }
table.inv-table colgroup col.col-unit  { width: 15%; }
table.inv-table colgroup col.col-rate  { width: 11%; }
table.inv-table colgroup col.col-price { width: 17%; }
table.inv-table th { text-align: left; font-weight: bold; padding: 1.4mm 2.5mm;
                     border-bottom: 1.5pt solid #000; white-space: nowrap; overflow: hidden; }
table.inv-table th.num { text-align: right; }
table.inv-table td { padding: 1.1mm 2.5mm; border-bottom: 0.3pt solid #ccc; vertical-align: top; }
table.inv-table td.num { text-align: right; white-space: nowrap; }
table.inv-table td.pos { color: #444; padding-right: 1mm; }
tr.section-head td { font-weight: bold; padding-top: 3mm; border-bottom: 0.5pt solid #888; }

/* Итоговый блок: правая колонка под таблицей услуг — линии только под цифрами */
.summary { width: 105mm; margin: 3mm 0 0 auto; }
.summary .totals-table { width: 100%; border-collapse: collapse; }
.summary .totals-table td { padding: 1mm 2mm; white-space: nowrap; }
.summary .totals-table td.lbl { text-align: left; }
.summary .totals-table td.val { text-align: right; }
/* У «Zwischensumme» верхней линии НЕТ: таблица услуг уже отделена своей
   нижней границей, вторая линия вплотную над итогом выглядит лишней. */
.summary .totals-table tr.t-sub td { font-weight: bold; }

/* Итог сразу после услуг (без Zwischensumme/Nachlass): закрываем таблицу
   услуг ЧЁРНОЙ линией во всю ширину и снимаем короткую линию у итога —
   иначе две линии идут вплотную. Классы ставит пагинатор, когда блок итога
   реально оказался на одном листе с таблицей. */
   Итог должен читаться как продолжение таблицы, поэтому убираются ОБА отступа:
   нижний у таблицы (класс на ней же — из блока итога до неё не дотянуться)
   и верхний у блока итога; остаётся только внутренний отступ строки. */
table.inv-table tr.row-close td { border-bottom: 1.2pt solid #000; }
table.inv-table.table-joined { margin-bottom: 0; }
.joined .summary { margin-top: 0; }
.joined .summary .totals-table tr.t-first td { border-top: none; padding-top: 1.8mm; }
.summary .totals-table tr.t-grand td { border-top: 1.2pt solid #000; font-weight: bold;
                                       font-size: 11pt; padding-top: 1.4mm; }

/* Свод по ставкам НДС (§ 14 Abs. 4 Nr. 8 UStG) — нетто/НДС/брутто по каждой ставке */
.vat-summary { margin-top: 5mm; }
.vat-summary .vs-title { font-weight: bold; font-size: 8.5pt; margin-bottom: 1.2mm; }
.vat-summary table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
.vat-summary th { text-align: right; font-weight: normal; color: #333; padding: 0.8mm 2mm;
                  border-bottom: 0.8pt solid #000; white-space: nowrap; }
.vat-summary td { text-align: right; padding: 0.9mm 2mm; border-bottom: 0.3pt solid #ddd;
                  white-space: nowrap; }
.vat-summary tr.vs-total td { font-weight: bold; border-top: 0.8pt solid #000; border-bottom: none; }
.vat-note { font-size: 8pt; margin-top: 2mm; color: #222; }
.vat-note div + div { margin-top: 0.8mm; }

.note { margin-top: 8mm; font-size: 9pt; }

/* Предупреждение о недостающих обязательных реквизитах — только на экране */
.compliance-warning { width: 210mm; margin: 0 auto 6mm; padding: 3mm 5mm;
                      border: 1.5pt solid #a00000; background: #fff2f2; color: #6b0000;
                      font-size: 9pt; }
.compliance-warning h3 { margin: 0 0 1.5mm 0; font-size: 10pt; }
.compliance-warning ul { margin: 0 0 1.5mm 5mm; padding: 0; }
.compliance-warning .cw-hint { font-size: 8pt; color: #555; }
@media print { .compliance-warning { display: none !important; } }
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
  </table>
  <div id="src-summary">${summaryInner}</div>
  <div id="src-note" class="note">${noteInner}</div>
  <div id="src-footer">${footerInner}</div>
  <div id="src-runhead">${runHeadInner}</div>
</div>

${warningHtml}
<div id="pages"></div>

<script>
(function () {
  // true → блок итогов начинается сразу с Gesamtbetrag (строк над ним нет)
  var JOIN_TOTAL = ${JSON.stringify(!hasRowsAboveTotal)};
  function paginate() {
    var src = document.getElementById('src-wrap');
    if (!src) return;
    var pagesRoot = document.getElementById('pages');
    var srcTable  = document.getElementById('src-table');
    var colgroupHTML = srcTable.querySelector('colgroup').outerHTML;
    var theadHTML    = srcTable.querySelector('thead').outerHTML;
    var lineRows  = Array.prototype.slice.call(srcTable.querySelector('tbody.lines').children);
    var letterhead = document.getElementById('src-letterhead');
    var summaryEl  = document.getElementById('src-summary');
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

    // 2. Итоги + свод по ставкам НДС — единым куском, не рвём: свод
    //    (§ 14 Abs. 4 Nr. 8 UStG) обязан читаться вместе с итогом.
    //    Это отдельный блок ПОСЛЕ таблицы услуг, поэтому при переносе на новый
    //    лист пустая таблица с шапкой не создаётся.
    if (summaryEl && summaryEl.innerHTML.replace(/\\s/g, '')) {
      var summaryBlock = document.createElement('div');
      summaryBlock.innerHTML = summaryEl.innerHTML;
      body.appendChild(summaryBlock);
      if (!fits(body)) {
        body.removeChild(summaryBlock);
        body = makePage(false);
        body.appendChild(summaryBlock);
      }
      // Итог идёт сразу за услугами (нет Zwischensumme/Nachlass) И блок реально
      // стоит под таблицей на том же листе → «сращиваем»: чёрная линия у
      // последней строки услуг вместо короткой линии над Gesamtbetrag.
      // Если блок уехал на отдельный лист — оставляем ему собственную линию.
      if (JOIN_TOTAL) {
        var prev = summaryBlock.previousElementSibling;
        if (prev && prev.tagName === 'TABLE') {
          var lineRowsOnPage = prev.querySelectorAll('tbody.lines > tr');
          if (lineRowsOnPage.length) {
            lineRowsOnPage[lineRowsOnPage.length - 1].className += ' row-close';
            prev.className += ' table-joined';   // снять нижний отступ таблицы
            summaryBlock.className += ' joined';
          }
        }
      }
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
