'use strict';

// Обязательные реквизиты счёта (§ 14 Abs. 4 UStG, § 33 UStDV).
//
// Один список на двоих: печатная форма показывает по нему предупреждение в
// предпросмотре, а команда «Выставить» по нему же ОТКАЗЫВАЕТ в выставлении.
// Разъезжаться этим проверкам нельзя — иначе счёт, на который форма ругалась,
// спокойно уходит клиенту.
//
// § 33 UStDV: до 250 € брутто (Kleinbetragsrechnung) адрес получателя,
// отдельный номер счёта и разбивка по получателю не обязательны. Выше этой
// суммы обязательны все реквизиты.

const KLEINBETRAG_LIMIT = 250;

/**
 * @param {Object} p
 * @param {Object} p.org      — организация (name, address, taxNumber)
 * @param {Object} p.client   — клиент (name, address)
 * @param {Object} p.invoice  — счёт (number)
 * @param {number|string} p.brutto — сумма к оплате
 * @returns {string[]} ключи i18n отсутствующих реквизитов (пусто — всё на месте)
 */
function missingRequisites({ org, client, invoice, brutto }) {
    const missing = [];
    const amount = Number(brutto) || 0;

    if (!(org && org.name))             missing.push('invoice_missing_org_name');
    if (!(org && org.address))          missing.push('invoice_missing_org_address');
    if (!(org && org.taxNumber))        missing.push('invoice_missing_tax_number');
    if (!(client && client.name))       missing.push('invoice_missing_client_name');
    // Порог Kleinbetragsrechnung (§ 33 UStDV) — по МОДУЛЮ суммы: сторно счёта
    // на 760 € сам отрицателен, и сравнение по значению объявляло бы его
    // мелким счётом, разрешая печать без адреса получателя.
    if (!(client && client.address) && Math.abs(amount) > KLEINBETRAG_LIMIT) {
        missing.push('invoice_missing_client_address');
    }
    if (!(invoice && invoice.number))   missing.push('invoice_missing_number');

    return missing;
}

module.exports = { missingRequisites, KLEINBETRAG_LIMIT };
