'use strict';

/**
 * paymentDocument — чем заполнить денежный документ ПО БРОНИ.
 *
 * Спрашивают двое (ТЗ «Платежи брони и журнал документов», §4.1):
 *   - проведение новой брони, превращающее её первый аванс в поступление
 *     (`hooks/posting.js`, через `ctx.createOnce`);
 *   - вкладка «Zahlungen» формы брони: «Добавить» открывает новый документ,
 *     заполненный методом формы `fillPaymentDocument`.
 * Правило одно — вид операции по коду из справочника, место хранения под способ
 * оплаты, — и живёт здесь, а не в двух копиях. Раньше оно жило в диалоге
 * «Anzahlung hinzufügen», который убран.
 *
 * ПОЧЕМУ В БРОНИ, а не в кассе: денежный документ не знает, что бывает бронь;
 * бронь знает, что у неё бывает аванс и возврат. Обратная зависимость завела бы в
 * кассу знание о бронировании.
 */

const path = require('path');
const FW = path.join(__dirname, '..', '..', '..', 'node_modules', 'my-old-space');
const dbGateway = require(path.join(FW, 'drive_root', 'dbGateway'));
// «Куда можно положить оплату этим способом» — правило денежного приложения.
const cashPlaces = require('../../cash/lib/cashPlaces');

/**
 * Вид операции по виду документа — КОД в справочнике `cash_operation_types`, а не
 * UID: переименование или перенастройка вида операции — правка данных, не кода.
 * Поступление по брони — аванс, выплата по брони — возврат аванса.
 */
const OPERATION_CODE = {
    cash_receipts: 'prepayment',
    cash_payments: 'prepayment_refund'
};

/**
 * Вид операции по коду: сначала собственный вид организации, затем общий
 * (`organizationId` пуст) — организация может переопределить поставляемый вид, не
 * ломая его остальным. Спросить обоих одним `IN (…, NULL)` нельзя: SQL не сравнивает
 * с NULL через IN, и общий вид молча не нашёлся бы.
 *
 * @param {object} p — `{ code, organizationId, sessionID, gateway }`
 * @returns {Promise<object|null>} строка `cash_operation_types`
 */
async function findOperationType({ code, organizationId, sessionID, gateway }) {
    if (!code) return null;
    const gw = gateway || dbGateway;
    const read = async (where) => {
        const rows = await gw.execute({
            operation: 'read', table: 'cash_operation_types', where,
            options: { raw: true, limit: 1 },
            context: gateway ? undefined : { appName: 'booking', sessionID }
        });
        return (Array.isArray(rows) && rows[0]) || null;
    };
    if (organizationId) {
        const own = await read({ code, organizationId });
        if (own) return own;
    }
    return await read({ code, organizationId: null });
}

/**
 * Место хранения под способ оплаты (наличные — в кассу, перевод и карта — на
 * безналичное место): правило `cashPlaces`, им же проверяет документ при записи.
 */
async function placeFor({ organizationId, method, sessionID, gateway }) {
    return await cashPlaces.findPlaceForMethod({
        organizationId, method, sessionID, appName: 'booking', gateway
    });
}

module.exports = { OPERATION_CODE, findOperationType, placeFor };
