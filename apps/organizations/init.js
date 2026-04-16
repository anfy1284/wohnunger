'use strict';

// Регистрация кастомных лейаутов при старте сервера.
// Этот файл автоматически вызывается фреймворком (drive_forms/init.js).

module.exports = async function (modelsDB) {
    try {
        const layoutMemory   = require('../../node_modules/my-old-space/drive_root/layoutMemory');
        const { loadScript, loadServerScript, Utilities } = require('../../node_modules/my-old-space');


        // ─────────────────────────────────────────────────────────────────
        //  Серверный скрипт: функции с доступом к БД.
        //  Функции получают (params, ctx) где ctx = { sessionID, user, role }
        // ─────────────────────────────────────────────────────────────────
        const serverScriptName = loadServerScript('organizations.bookingActions', {

            // ── Серверные события формы ──────────────────────────────────
            // Привязываются в saveLayout({ events: { ... } }) — это события
            // самой формы как UI-объекта.

            // Вызывается сервером ДО записи в БД.
            // Здесь: заполняем organizationId в основной записи (если скрыто в форме)
            // и во все строки ТЧ.
            async onBeforeSave({ record, changes, tabularSections }, ctx) {
                // Если organizationId не пришёл от клиента — берём из профиля пользователя
                if (!changes.organizationId) {
                    try {
                        const globalCtx = require('../../node_modules/my-old-space/drive_root/globalServerContext');
                        const user = await globalCtx.getUserBySessionID(ctx.sessionID);
                        if (user && user.organizationId) {
                            changes.organizationId = user.organizationId;
                        }
                    } catch (e) {
                        console.warn('[onBeforeSave] Could not resolve user org:', e && e.message);
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

            // ── Прочие серверные методы (вызываются через callServer) ───

            async getBookingStatus({ bookingId } = {}, ctx) {
                if (!bookingId) return { error: 'bookingId required' };
                const booking = await modelsDB.Bookings.findByPk(bookingId, { raw: true });
                if (!booking) return { error: 'Бронирование не найдено' };
                return { name: booking.name, status: booking.status };
            },

            // ── Расчёт стоимости бронирования ──────────────────────────
            async calculateBookingCost({ bookingId } = {}, ctx) {
                if (!bookingId) return { error: 'bookingId обязателен' };
                const booking = await modelsDB.Bookings.findByPk(bookingId, { raw: true });
                if (!booking) return { error: 'Бронирование не найдено' };

                const checkIn = new Date(booking.checkIn);
                const checkOut = new Date(booking.checkOut);
                const nights = Math.round((checkOut - checkIn) / 86400000);
                if (nights <= 0) return { error: 'Некорректные даты' };

                const rooms = await modelsDB.BookingRooms.findAll({ where: { bookingId }, raw: true });
                const allGuests = await modelsDB.BookingGuests.findAll({ where: { bookingId }, raw: true });
                const allRoomSvcs = await modelsDB.BookingRoomServices.findAll({ where: { bookingId }, raw: true });

                const guestTypes = await modelsDB.GuestTypes.findAll({ raw: true });
                const gtMap = {};
                for (const gt of guestTypes) gtMap[gt.UID] = gt;

                const roomIds = rooms.map(r => r.roomId).filter(Boolean);
                const roomRecs = roomIds.length ? await modelsDB.Rooms.findAll({ where: { UID: roomIds }, raw: true }) : [];
                const roomMap = {};
                for (const r of roomRecs) roomMap[r.UID] = r;

                const roomPrices = roomIds.length
                    ? await modelsDB.RoomPrices.findAll({ where: { roomId: roomIds }, raw: true }) : [];

                const serviceIds = [...new Set(allRoomSvcs.map(s => s.serviceId).filter(Boolean))];
                const svcRecs = serviceIds.length
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
                    const rSvcs = allRoomSvcs.filter(s => s.bookingRoomId === room.UID);
                    const rInfo = roomMap[room.roomId];
                    const rLabel = rInfo ? rInfo.number : '?';

                    // Классификация гостей по возрасту
                    let adults = 0, kids6_15 = 0, kids3_5 = 0, kids2 = 0, infants = 0;
                    for (const g of rGuests) {
                        const gt = gtMap[g.guestTypeId];
                        if (!gt) continue;
                        const c = g.count || 1;
                        if (gt.ageFrom >= 16) adults += c;
                        else if (gt.ageFrom >= 6) kids6_15 += c;
                        else if (gt.ageFrom >= 3) kids3_5 += c;
                        else if (gt.ageFrom >= 2) kids2 += c;
                        else infants += c;
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
                            sectionLabel: 'Проживание',
                            label: 'Комн. ' + rLabel + ' (' + billingGuests + ' гост.) × ' + nights + ' ноч.',
                            quantity: nights, unitPrice: rp.price,
                            taxRate: rp.taxRate != null ? rp.taxRate : 7,
                            amount: r2(rp.price * nights), sortOrder: ++sortOrd
                        });
                    }

                    // 2. Дети 3-5 лет: 10 €/ночь, 7% MwSt
                    if (kids3_5 > 0) {
                        const qty = kids3_5 * nights;
                        lines.push({
                            UID: Utilities.generateUID('InvoiceLines'),
                            bookingId, bookingRoomId: room.UID, organizationId: orgId,
                            guestTypeId: '000000000-guest-type-0003',
                            sectionLabel: 'Проживание',
                            label: 'Дети 3-5 лет (' + kids3_5 + ' чел.) × ' + nights + ' ноч.',
                            quantity: qty, unitPrice: 10, taxRate: 7,
                            amount: r2(qty * 10), sortOrder: ++sortOrd
                        });
                    }

                    // 2б. Дети 2 лет: 10 €/ночь, 7% MwSt (завтрак — бесплатно)
                    if (kids2 > 0) {
                        const qty2 = kids2 * nights;
                        lines.push({
                            UID: Utilities.generateUID('InvoiceLines'),
                            bookingId, bookingRoomId: room.UID, organizationId: orgId,
                            guestTypeId: '000000000-guest-type-0005',
                            sectionLabel: 'Проживание',
                            label: 'Дети 2 лет (' + kids2 + ' чел.) × ' + nights + ' ноч.',
                            quantity: qty2, unitPrice: 10, taxRate: 7,
                            amount: r2(qty2 * 10), sortOrder: ++sortOrd
                        });
                    }

                    // 3. Курортный сбор (Kurbeitrag) — 0% MwSt
                    if (adults > 0) {
                        const qty = adults * nights;
                        lines.push({
                            UID: Utilities.generateUID('InvoiceLines'),
                            bookingId, bookingRoomId: room.UID, organizationId: orgId,
                            guestTypeId: '000000000-guest-type-0001',
                            sectionLabel: 'Курортный сбор',
                            label: 'Взрослые (' + adults + ') × ' + nights + ' ноч.',
                            quantity: qty, unitPrice: 2.10, taxRate: 0,
                            amount: r2(qty * 2.10), sortOrder: ++sortOrd
                        });
                    }
                    if (kids6_15 > 0) {
                        const qty = kids6_15 * nights;
                        lines.push({
                            UID: Utilities.generateUID('InvoiceLines'),
                            bookingId, bookingRoomId: room.UID, organizationId: orgId,
                            guestTypeId: '000000000-guest-type-0002',
                            sectionLabel: 'Курортный сбор',
                            label: 'Дети 6-15 (' + kids6_15 + ') × ' + nights + ' ноч.',
                            quantity: qty, unitPrice: 1.00, taxRate: 0,
                            amount: r2(qty * 1.00), sortOrder: ++sortOrd
                        });
                    }

                    // 4. Услуги из BookingRoomServices (ServicePrices)
                    for (const rs of rSvcs) {
                        const svc = svcMap[rs.serviceId];
                        if (!svc) continue;
                        const cnt = rs.count || 1;
                        const agePrices = svcPrices.filter(sp =>
                            sp.serviceId === rs.serviceId && sp.ageFrom != null
                        );

                        if (agePrices.length > 0 && svc.chargeType === 'per_night') {
                            // Дифференциация по возрасту (напр. завтрак)
                            const groups = [
                                { gtId: '000000000-guest-type-0001', n: adults, lbl: 'взр.' },
                                { gtId: '000000000-guest-type-0002', n: kids6_15, lbl: '6-15' },
                                { gtId: '000000000-guest-type-0003', n: kids3_5, lbl: '3-5' },
                                { gtId: '000000000-guest-type-0005', n: kids2,   lbl: '2 г.' },
                                { gtId: '000000000-guest-type-0004', n: infants, lbl: '0-1' },
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
                                    label: svc.name + ' — ' + ag.lbl + ' (' + ag.n + '×' + cnt + ') × ' + nights + ' ноч.',
                                    quantity: qty, unitPrice: sp.price, taxRate: svc.taxRate,
                                    amount: r2(qty * sp.price), sortOrder: ++sortOrd
                                });
                            }
                        } else {
                            // Единая цена за услугу
                            const sp = svcPrices.find(p =>
                                p.serviceId === rs.serviceId && p.ageFrom == null
                            );
                            const price = sp ? sp.price : 0;
                            if (price > 0) {
                                const qty = svc.chargeType === 'per_night' ? cnt * nights : cnt;
                                lines.push({
                                    UID: Utilities.generateUID('InvoiceLines'),
                                    bookingId, bookingRoomId: room.UID, organizationId: orgId,
                                    serviceId: rs.serviceId, sectionLabel: svc.name,
                                    label: svc.name + ' (' + cnt + ')' +
                                        (svc.chargeType === 'per_night' ? ' × ' + nights + ' ноч.' : ''),
                                    quantity: qty, unitPrice: price, taxRate: svc.taxRate,
                                    amount: r2(qty * price), sortOrder: ++sortOrd
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
                                sectionLabel: 'Проживание',
                                label: 'Финальная уборка — комн. ' + rLabel,
                                quantity: 1, unitPrice: csp.price, taxRate: 7,
                                amount: csp.price, sortOrder: ++sortOrd
                            });
                        }
                    }
                }

                return { lines };
            },

        }, 'user');

        // ─────────────────────────────────────────────────────────────────
        //  Клиентские функции формы бронирования.
        //  serverUID встраивается в текст скрипта при загрузке (template literal).
        //  callServer() — глобальный хелпер, доступен в любом клиентском скрипте.
        // ─────────────────────────────────────────────────────────────────
        const clientUID = await loadScript(`
            function sayHello(ev, ctx) {
                var name = ctx.fnParams && ctx.fnParams.name;
                showAlert('Привет, ' + (name || 'незнакомец') + '!');
            }

            function say(ev, ctx) {
                var p = ctx.fnParams || {};
                showAlert(p.name + ': ' + p.message);
            }

            async function showBookingStatus(ev, ctx) {
                var bookingId = ctx.fnParams && ctx.fnParams.bookingId;
                if (!bookingId) {
                    var uidEntry = ctx.form._dataMap && ctx.form._dataMap['UID'];
                    bookingId = uidEntry && uidEntry.value;
                }
                const result = await callServer('${serverScriptName}', 'getBookingStatus', { bookingId });
                if (result.error) { showAlert('Ошибка: ' + result.error); return; }
                showAlert('Бронирование: ' + result.name + '\\nСтатус: ' + result.status);
            }

            // Вызывается при активации строки в таблице номеров.
            // rowIndex — аргумент от onRowActivate, ctx — контекст формы.
            function onRoomActivated(rowIndex, ctx) {
                console.log('Выбран номер, строка:', rowIndex);
            }

            async function calculateCost(ev, ctx) {
                var form = ctx.form;
                var uidEntry = form._dataMap && form._dataMap['UID'];
                var bookingId = uidEntry && uidEntry.value;
                if (!bookingId) { showAlert('Сначала сохраните бронирование'); return; }

                var result = await callServer('${serverScriptName}', 'calculateBookingCost', { bookingId: bookingId });
                if (result.error) { showAlert('Ошибка: ' + result.error); return; }

                // Перезаписать данные ТЧ invoice_lines
                var tbl = form.controlsMap['ts_invoice_lines'];
                if (tbl) {
                    var rows = tbl.data_getRows('invoice_lines');
                    rows.length = 0;
                    var newLines = result.lines || [];
                    for (var i = 0; i < newLines.length; i++) rows.push(newLines[i]);
                    if (tbl._invokeRenderBodyRows) tbl._invokeRenderBodyRows();
                }
                form.setModified(true);
                showAlert('Расчёт выполнен: ' + (result.lines ? result.lines.length : 0) + ' позиций');
            }

            async function printInvoice(ev, ctx) {
                var form = ctx.form;
                var uidEntry = form._dataMap && form._dataMap['UID'];
                var bookingId = uidEntry && uidEntry.value;
                if (!bookingId) { showAlert('Сначала сохраните бронирование'); return; }

                var result = await callServer('reports.actions', 'generateInvoiceHTML', { bookingId: bookingId });
                if (result.error) { showAlert('Ошибка: ' + result.error); return; }

                // Открываем в Win95-окне printPreview
                if (window.MySpace && typeof window.MySpace.open === 'function') {
                    await window.MySpace.open('printPreview', { html: result.html });
                }
            }

            return { sayHello, say, showBookingStatus, onRoomActivated, calculateCost, printInvoice };
        `, 'user');

        // ─────────────────────────────────────────────────────────────────
        //  uniRecordForm / bookings — роль "user"
        //
        //  Дизайн-решения:
        //  1. Шапка (заголовок брони) — в горизонтальной группе: номер,
        //     клиент, гостиница и статус хорошо смотрятся в одну строку.
        //  2. Даты — отдельная компактная группа рядом.
        //  3. Статус — emunList (закрытый список допустимых значений)
        //     вместо свободного textbox — не даёт ввести произвольный текст.
        //  4. organizationId скрыт (заполняется автоматически из контекста
        //     пользователя, рядовому сотруднику его видеть незачем).
        //  5. Примечания — внизу, в полную ширину.
        //  6. Кнопки — стандартный блок Сохранить / Отмена.
        //
        //  Табличные части (BookingRooms, BookingGuests, BookingRoomServices,
        //  Invoices) генерируются фреймворком автоматически из метаданных
        //  модели — они не описываются здесь и добавляются поверх этого лейаута.
        // ─────────────────────────────────────────────────────────────────

        const bookingsLayout = [
            {
                type: 'group',
                caption: 'Бронирование',
                orientation: 'horizontal',
                layout: [
                    // Левая колонка: главные реквизиты
                    {
                        type: 'group',
                        caption: '',
                        orientation: 'vertical',
                        layout: [
                            {
                                type: 'textbox',
                                name: 'name',
                                data: 'name',
                                caption: 'Номер / название'
                            },
                            {
                                type: 'recordSelector',
                                name: 'clientId',
                                data: 'clientId',
                                caption: 'Клиент',
                                properties: {
                                    showSelectionButton: true,
                                    selection: {
                                        table: 'clients',
                                        idField: 'UID',
                                        displayField: 'name'
                                    }
                                }
                            },
                            {
                                type: 'recordSelector',
                                name: 'hotelId',
                                data: 'hotelId',
                                caption: 'Гостиница',
                                properties: {
                                    showSelectionButton: true,
                                    selection: {
                                        table: 'hotels',
                                        idField: 'UID',
                                        displayField: 'name'
                                    }
                                }
                            },
                            {
                                type: 'recordSelector',
                                name: 'organizationId',
                                data: 'organizationId',
                                caption: 'Организация',
                                properties: {
                                    showSelectionButton: true,
                                    selection: {
                                        table: 'organizations',
                                        idField: 'UID',
                                        displayField: 'name'
                                    }
                                }
                            }
                        ]
                    },
                    // Правая колонка: даты и статус
                    {
                        type: 'group',
                        caption: '',
                        orientation: 'vertical',
                        layout: [
                            {
                                type: 'date',
                                name: 'checkIn',
                                data: 'checkIn',
                                caption: 'Заезд'
                            },
                            {
                                type: 'date',
                                name: 'checkOut',
                                data: 'checkOut',
                                caption: 'Выезд'
                            },
                            {
                                type: 'emunList',
                                name: 'status',
                                data: 'status',
                                caption: 'Статус',
                                options: [
                                    { value: 'draft',      caption: 'Черновик' },
                                    { value: 'confirmed',  caption: 'Подтверждено' },
                                    { value: 'checkedIn',  caption: 'Заезд' },
                                    { value: 'checkedOut', caption: 'Выезд' },
                                    { value: 'cancelled',  caption: 'Отменено' }
                                ]
                            }
                        ]
                    }
                ]
            },
            {
                type: 'group',
                caption: 'Примечания',
                orientation: 'vertical',
                layout: [
                    {
                        type: 'textarea',
                        name: 'notes',
                        data: 'notes',
                        caption: ''
                    }
                ]
            },
            // Номера размещения (справа, мастер) + Гости (слева, деталь) — горизонтально
            {
                type: 'group',
                caption: '',
                orientation: 'horizontal',
                layout: [
                    {
                        type: 'group',
                        caption: 'Номера размещения',
                        orientation: 'vertical',
                        layout: [{
                            type: 'table',
                            name: 'ts_booking_rooms',
                            data: 'booking_rooms',
                            columns: [
                                {
                                    caption: 'Номер', data: 'roomId', width: 200,
                                    inputType: 'recordSelector',
                                    properties: {
                                        showSelectionButton: true,
                                        selection: { table: 'rooms', idField: 'UID', displayField: 'number' }
                                    }
                                }
                            ],
                            properties: {
                                editMode: 'cell-immediate',
                                visibleRows: 8,
                                tabularFilter: { bookingId: '{UID}' },
                                masterFor:   ['ts_booking_guests', 'ts_booking_room_services'],
                                masterField: 'UID',
                                detailField: 'bookingRoomId'
                            },
                            // События: строка = имя функции из clientScript
                            events: {
                                onRowActivate: 'onRoomActivated'
                            }
                        }]
                    },
                    {
                        type: 'group',
                        caption: 'Гости',
                        orientation: 'vertical',
                        layout: [{
                            type: 'table',
                            name: 'ts_booking_guests',
                            data: 'booking_guests',
                            columns: [
                                {
                                    caption: 'Тип гостя', data: 'guestTypeId', width: 180,
                                    inputType: 'recordSelector',
                                    properties: {
                                        showSelectionButton: true,
                                        selection: { table: 'guest_types', idField: 'UID', displayField: 'name' }
                                    }
                                },
                                { caption: 'Кол-во', data: 'count', width: 80 }
                            ],
                            properties: {
                                editMode: 'cell-immediate',
                                visibleRows: 8,
                                tabularFilter: { bookingId: '{UID}' }
                            }
                        }]
                    }
                ]
            },
            // Услуги бронирования (фильтруются вместе с Гостями при выборе Номера)
            {
                type: 'group',
                caption: 'Услуги',
                orientation: 'vertical',
                layout: [{
                    type: 'table',
                    name: 'ts_booking_room_services',
                    data: 'booking_room_services',
                    columns: [
                        {
                            caption: 'Номер', data: 'bookingRoomId', width: 150,
                            inputType: 'recordSelector',
                            properties: {
                                showSelectionButton: true,
                                selection: { table: 'booking_rooms', idField: 'UID', displayField: 'UID' }
                            }
                        },
                        {
                            caption: 'Услуга', data: 'serviceId', width: 200,
                            inputType: 'recordSelector',
                            properties: {
                                showSelectionButton: true,
                                selection: { table: 'services', idField: 'UID', displayField: 'name' }
                            }
                        },
                        { caption: 'Кол-во', data: 'count', width: 80 }
                    ],
                    properties: {
                        editMode: 'cell-immediate',
                        visibleRows: 5,
                        tabularFilter: { bookingId: '{UID}' }
                    }
                }]
            },
            // Спецификация счёта (InvoiceLines) — рассчитывается кнопкой
            {
                type: 'group',
                caption: 'Спецификация счёта',
                orientation: 'vertical',
                layout: [{
                    type: 'table',
                    name: 'ts_invoice_lines',
                    data: 'invoice_lines',
                    columns: [
                        { caption: 'Раздел',  data: 'sectionLabel', width: 140 },
                        { caption: 'Описание', data: 'label',        width: 300 },
                        { caption: 'Кол-во',   data: 'quantity',     width: 70 },
                        { caption: 'Цена',     data: 'unitPrice',    width: 90 },
                        { caption: 'НДС %',    data: 'taxRate',      width: 60 },
                        { caption: 'Сумма',    data: 'amount',       width: 100 }
                    ],
                    properties: {
                        visibleRows: 10,
                        tabularFilter: { bookingId: '{UID}' }
                    }
                }]
            },
            {
                type: 'group',
                caption: '',
                orientation: 'horizontal',
                layout: [
                    { type: 'button', action: 'save',    caption: 'Сохранить' },
                    { type: 'button', action: 'cancel',  caption: 'Отмена' },
                    { type: 'button', name: 'btnHello',  caption: 'Привет Васе',  events: { onClick: { fn: 'sayHello',  fnParams: { name: 'Вася' } } } },
                    { type: 'button', name: 'btnSay',    caption: 'Вася говорит', events: { onClick: { fn: 'say',       fnParams: { name: 'Вася', message: 'Как дела?' } } } },
                    { type: 'button', name: 'btnStatus', caption: 'Статус брони', events: { onClick: { fn: 'showBookingStatus', fnParams: { bookingId: '{data.UID}' } } } },
                    { type: 'button', name: 'btnCalc',   caption: 'Рассчитать стоимость', events: { onClick: 'calculateCost' } },
                    { type: 'button', name: 'btnPrint',  caption: 'Печать счёта',         events: { onClick: 'printInvoice' } }
                ]
            }
        ];

        await layoutMemory.saveLayout({
            appName: 'uniRecordForm',
            tableName: 'bookings',
            roles: 'user',
            layout: bookingsLayout,
            clientScript: clientUID,
            events: {
                onBeforeSave: { serverScript: serverScriptName, fn: 'onBeforeSave' }
            }
        });

        console.log('[organizations/init] Custom layouts registered');
        console.log('[organizations/init] serverScriptName:', serverScriptName);
        console.log('[organizations/init] clientUID:', clientUID);
    } catch (e) {
        console.error('[organizations/init] Failed to register layouts:', e && e.message || e);
    }
};
