'use strict';

// Серверные функции формы "Бронирование".
//
// Экспортирует фабрику: module.exports = function(modelsDB, Utilities) { return { ... }; }
// Вызывается из init.js: loadServerScript('booking.bookingActions', require('./bookings.server')(modelsDB, Utilities), 'user')
//
// Каждая функция получает (params, ctx) где ctx = { sessionID, user, role }.

const { tForSession } = require('../../../node_modules/my-old-space/drive_forms/globalServerContext');

module.exports = function (modelsDB, Utilities) {
    return {

        // ── Серверное событие формы ──────────────────────────────────────
        // Вызывается ДО записи в БД.
        // Заполняем organizationId в основной записи и во все строки ТЧ.
        async onBeforeSave({ record, changes, tabularSections }, ctx) {
            if (!changes.organizationId) {
                try {
                    const globalCtx = require('../../../node_modules/my-old-space/drive_root/globalServerContext');
                    const user = await globalCtx.getUserBySessionID(ctx.sessionID);
                    if (user && user.organizationId) {
                        changes.organizationId = user.organizationId;
                    }
                } catch (e) {
                    console.warn('[booking/onBeforeSave] Could not resolve user org:', e && e.message);
                }
            }

            const orgId = changes.organizationId || (record && record.organizationId);
            if (!orgId) return;
            for (const rows of Object.values(tabularSections)) {
                for (const row of rows) {
                    if (!row.organizationId) row.organizationId = orgId;
                }
            }
        },

        // ── RPC-методы (вызываются через callServer с клиента) ──────────

        async getBookingStatus({ bookingId } = {}, ctx) {
            if (!bookingId) return { error: await tForSession('bookingId required', ctx.sessionID) };
            const booking = await modelsDB.Bookings.findByPk(bookingId, { raw: true });
            if (!booking) return { error: await tForSession('Booking not found', ctx.sessionID) };
            return { name: booking.name, status: booking.status };
        },

        // ── Расчёт стоимости бронирования ──────────────────────────────
        async calculateBookingCost({ bookingId } = {}, ctx) {
            if (!bookingId) return { error: await tForSession('bookingId required', ctx.sessionID) };
            const booking = await modelsDB.Bookings.findByPk(bookingId, { raw: true });
            if (!booking) return { error: await tForSession('Booking not found', ctx.sessionID) };

            const checkIn  = new Date(booking.checkIn);
            const checkOut = new Date(booking.checkOut);
            const nights   = Math.round((checkOut - checkIn) / 86400000);
            if (nights <= 0) return { error: await tForSession('Invalid dates', ctx.sessionID) };

            const rooms      = await modelsDB.BookingRooms.findAll({ where: { bookingId }, raw: true });
            const allGuests  = await modelsDB.BookingGuests.findAll({ where: { bookingId }, raw: true });
            const allRoomSvcs = await modelsDB.BookingRoomServices.findAll({ where: { bookingId }, raw: true });

            const guestTypes = await modelsDB.GuestTypes.findAll({ raw: true });
            const gtMap = {};
            for (const gt of guestTypes) gtMap[gt.UID] = gt;

            const roomIds  = rooms.map(r => r.roomId).filter(Boolean);
            const roomRecs = roomIds.length ? await modelsDB.Rooms.findAll({ where: { UID: roomIds }, raw: true }) : [];
            const roomMap  = {};
            for (const r of roomRecs) roomMap[r.UID] = r;

            const roomPrices = roomIds.length
                ? await modelsDB.RoomPrices.findAll({ where: { roomId: roomIds }, raw: true }) : [];

            const serviceIds = [...new Set(allRoomSvcs.map(s => s.serviceId).filter(Boolean))];
            const svcRecs    = serviceIds.length
                ? await modelsDB.Services.findAll({ where: { UID: serviceIds }, raw: true }) : [];
            const svcMap = {};
            for (const s of svcRecs) svcMap[s.UID] = s;

            const svcPrices = serviceIds.length
                ? await modelsDB.ServicePrices.findAll({ where: { serviceId: serviceIds }, raw: true }) : [];

            // ServicePrices с roomId — Endreinigung
            const cleaningPrices = roomIds.length
                ? await modelsDB.ServicePrices.findAll({ where: { roomId: roomIds }, raw: true }) : [];

            const lines = [];
            let sortOrd = 0;
            const orgId = booking.organizationId;
            const r2 = v => Math.round(v * 100) / 100;

            for (const room of rooms) {
                const rGuests = allGuests.filter(g => g.bookingRoomId === room.UID);
                const rSvcs   = allRoomSvcs.filter(s => s.bookingRoomId === room.UID);
                const rInfo   = roomMap[room.roomId];
                const rLabel  = rInfo ? rInfo.number : '?';

                // Классификация гостей по возрасту
                let adults = 0, kids6_15 = 0, kids3_5 = 0, kids2 = 0, infants = 0;
                for (const g of rGuests) {
                    const gt = gtMap[g.guestTypeId];
                    if (!gt) continue;
                    const c = g.count || 1;
                    if      (gt.ageFrom >= 16) adults  += c;
                    else if (gt.ageFrom >= 6)  kids6_15 += c;
                    else if (gt.ageFrom >= 3)  kids3_5  += c;
                    else if (gt.ageFrom >= 2)  kids2    += c;
                    else                       infants  += c;
                }
                const billingGuests = adults + kids6_15;

                // 1. Проживание (из RoomPrices по номеру, периоду, кол-ву гостей)
                const rp = roomPrices.find(p =>
                    p.roomId === room.roomId &&
                    p.guestsCount === billingGuests &&
                    new Date(p.dateFrom) <= checkIn && new Date(p.dateTo) >= checkIn
                );
                if (rp) {
                    lines.push({
                        UID: Utilities.generateUID('InvoiceLines'),
                        bookingId, bookingRoomId: room.UID, organizationId: orgId,
                        sectionLabel: await tForSession('accommodation_section', ctx.sessionID),
                        label:    'Комн. ' + rLabel + ' (' + billingGuests + ' гост.) × ' + nights + ' ноч.',
                        quantity: nights, unitPrice: rp.price,
                        taxRate:  rp.taxRate != null ? rp.taxRate : 7,
                        amount:   r2(rp.price * nights), sortOrder: ++sortOrd
                    });
                }

                // 2. Дети 3-5 лет: 10 €/ночь, 7% MwSt
                if (kids3_5 > 0) {
                    const qty = kids3_5 * nights;
                    lines.push({
                        UID: Utilities.generateUID('InvoiceLines'),
                        bookingId, bookingRoomId: room.UID, organizationId: orgId,
                        guestTypeId: '000000000-guest-type-0003',
                        sectionLabel: await tForSession('accommodation_section', ctx.sessionID),
                        label:    'Дети 3-5 лет (' + kids3_5 + ' чел.) × ' + nights + ' ноч.',
                        quantity: qty, unitPrice: 10, taxRate: 7,
                        amount:   r2(qty * 10), sortOrder: ++sortOrd
                    });
                }

                // 2б. Дети 2 лет: 10 €/ночь, 7% MwSt (завтрак — бесплатно)
                if (kids2 > 0) {
                    const qty2 = kids2 * nights;
                    lines.push({
                        UID: Utilities.generateUID('InvoiceLines'),
                        bookingId, bookingRoomId: room.UID, organizationId: orgId,
                        guestTypeId: '000000000-guest-type-0005',
                        sectionLabel: await tForSession('accommodation_section', ctx.sessionID),
                        label:    'Дети 2 лет (' + kids2 + ' чел.) × ' + nights + ' ноч.',
                        quantity: qty2, unitPrice: 10, taxRate: 7,
                        amount:   r2(qty2 * 10), sortOrder: ++sortOrd
                    });
                }

                // 3. Курортный сбор (Kurbeitrag) — 0% MwSt
                if (adults > 0) {
                    const qty = adults * nights;
                    lines.push({
                        UID: Utilities.generateUID('InvoiceLines'),
                        bookingId, bookingRoomId: room.UID, organizationId: orgId,
                        guestTypeId: '000000000-guest-type-0001',
                        sectionLabel: await tForSession('resort_fee_section', ctx.sessionID),
                        label:    'Взрослые (' + adults + ') × ' + nights + ' ноч.',
                        quantity: qty, unitPrice: 2.10, taxRate: 0,
                        amount:   r2(qty * 2.10), sortOrder: ++sortOrd
                    });
                }
                if (kids6_15 > 0) {
                    const qty = kids6_15 * nights;
                    lines.push({
                        UID: Utilities.generateUID('InvoiceLines'),
                        bookingId, bookingRoomId: room.UID, organizationId: orgId,
                        guestTypeId: '000000000-guest-type-0002',
                        sectionLabel: await tForSession('resort_fee_section', ctx.sessionID),
                        label:    'Дети 6-15 (' + kids6_15 + ') × ' + nights + ' ноч.',
                        quantity: qty, unitPrice: 1.00, taxRate: 0,
                        amount:   r2(qty * 1.00), sortOrder: ++sortOrd
                    });
                }

                // 4. Услуги из BookingRoomServices (ServicePrices)
                for (const rs of rSvcs) {
                    const svc = svcMap[rs.serviceId];
                    if (!svc) continue;
                    const cnt       = rs.count || 1;
                    const agePrices = svcPrices.filter(sp =>
                        sp.serviceId === rs.serviceId && sp.ageFrom != null
                    );

                    if (agePrices.length > 0 && svc.chargeType === 'per_night') {
                        // Дифференциация по возрасту (напр. завтрак)
                        const groups = [
                            { gtId: '000000000-guest-type-0001', n: adults,   lbl: 'взр.' },
                            { gtId: '000000000-guest-type-0002', n: kids6_15, lbl: '6-15' },
                            { gtId: '000000000-guest-type-0003', n: kids3_5,  lbl: '3-5'  },
                            { gtId: '000000000-guest-type-0005', n: kids2,    lbl: '2 г.' },
                            { gtId: '000000000-guest-type-0004', n: infants,  lbl: '0-1'  },
                        ];
                        for (const ag of groups) {
                            if (ag.n <= 0) continue;
                            const gt = gtMap[ag.gtId];
                            if (!gt) continue;
                            const sp = agePrices.find(p =>
                                p.ageFrom <= gt.ageFrom &&
                                (p.ageTo == null || p.ageTo >= (gt.ageTo != null ? gt.ageTo : gt.ageFrom))
                            );
                            if (!sp || sp.price === 0) continue;
                            const qty = ag.n * cnt * nights;
                            lines.push({
                                UID: Utilities.generateUID('InvoiceLines'),
                                bookingId, bookingRoomId: room.UID, organizationId: orgId,
                                serviceId: rs.serviceId, guestTypeId: ag.gtId,
                                sectionLabel: svc.name,
                                label:    svc.name + ' — ' + ag.lbl + ' (' + ag.n + '×' + cnt + ') × ' + nights + ' ноч.',
                                quantity: qty, unitPrice: sp.price, taxRate: svc.taxRate,
                                amount:   r2(qty * sp.price), sortOrder: ++sortOrd
                            });
                        }
                    } else {
                        // Единая цена за услугу
                        const sp    = svcPrices.find(p => p.serviceId === rs.serviceId && p.ageFrom == null);
                        const price = sp ? sp.price : 0;
                        if (price > 0) {
                            const qty = svc.chargeType === 'per_night' ? cnt * nights : cnt;
                            lines.push({
                                UID: Utilities.generateUID('InvoiceLines'),
                                bookingId, bookingRoomId: room.UID, organizationId: orgId,
                                serviceId: rs.serviceId, sectionLabel: svc.name,
                                label:    svc.name + ' (' + cnt + ')' +
                                          (svc.chargeType === 'per_night' ? ' × ' + nights + ' ноч.' : ''),
                                quantity: qty, unitPrice: price, taxRate: svc.taxRate,
                                amount:   r2(qty * price), sortOrder: ++sortOrd
                            });
                        }
                    }
                }

                // 5. Финальная уборка (Endreinigung) при ≤3 ночей
                if (nights <= 3) {
                    const csp = cleaningPrices.find(sp => sp.roomId === room.roomId);
                    if (csp) {
                        lines.push({
                            UID: Utilities.generateUID('InvoiceLines'),
                            bookingId, bookingRoomId: room.UID, organizationId: orgId,
                            serviceId: csp.serviceId || null,
                            sectionLabel: await tForSession('accommodation_section', ctx.sessionID),
                            label:    'Финальная уборка — комн. ' + rLabel,
                            quantity: 1, unitPrice: csp.price, taxRate: 7,
                            amount:   csp.price, sortOrder: ++sortOrd
                        });
                    }
                }
            }

            return { lines };
        },

    };
};
