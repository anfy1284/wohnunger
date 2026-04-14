'use strict';

// Регистрация кастомных лейаутов при старте сервера.
// Этот файл автоматически вызывается фреймворком (drive_forms/init.js).

module.exports = async function (modelsDB) {
    try {
        const layoutMemory   = require('../../node_modules/my-old-space/drive_root/layoutMemory');
        const { loadScript, loadServerScript } = require('../../node_modules/my-old-space');


        // ─────────────────────────────────────────────────────────────────
        //  Серверный скрипт: функции с доступом к БД.
        //  Функции получают (params, ctx) где ctx = { sessionID, user, role }
        // ─────────────────────────────────────────────────────────────────
        const serverScriptName = loadServerScript('organizations.bookingActions', {

            // ── Серверные события формы ──────────────────────────────────
            // Привязываются в saveLayout({ events: { ... } }) — это события
            // самой формы как UI-объекта.

            // Вызывается сервером ДО записи в БД.
            // Здесь: заполняем organizationId во все строки ТЧ,
            // т.к. поле скрыто в форме и клиент его не передаёт.
            async onBeforeSave({ record, changes, tabularSections }, ctx) {
                const orgId = record && record.organizationId;
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

            return { sayHello, say, showBookingStatus, onRoomActivated };
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
            {
                type: 'group',
                caption: '',
                orientation: 'horizontal',
                layout: [
                    { type: 'button', action: 'save',    caption: 'Сохранить' },
                    { type: 'button', action: 'cancel',  caption: 'Отмена' },
                    { type: 'button', name: 'btnHello',  caption: 'Привет Васе',  events: { onClick: { fn: 'sayHello',  fnParams: { name: 'Вася' } } } },
                    { type: 'button', name: 'btnSay',    caption: 'Вася говорит', events: { onClick: { fn: 'say',       fnParams: { name: 'Вася', message: 'Как дела?' } } } },
                    { type: 'button', name: 'btnStatus', caption: 'Статус брони', events: { onClick: { fn: 'showBookingStatus', fnParams: { bookingId: '{data.UID}' } } } }
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
