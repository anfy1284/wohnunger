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
            function sayHello({ name } = {}) {
                showAlert('Привет, ' + (name || 'незнакомец') + '!');
            }

            function say({ name, message } = {}) {
                showAlert(name + ': ' + message);
            }

            async function showBookingStatus({ bookingId } = {}) {
                const result = await callServer('${serverScriptName}', 'getBookingStatus', { bookingId });
                if (result.error) { showAlert('Ошибка: ' + result.error); return; }
                showAlert('Бронирование: ' + result.name + '\\nСтатус: ' + result.status);
            }

            return { sayHello, say, showBookingStatus };
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
            {
                type: 'group',
                caption: '',
                orientation: 'horizontal',
                layout: [
                    { type: 'button', action: 'save',      caption: 'Сохранить' },
                    { type: 'button', action: 'cancel',    caption: 'Отмена' },
                    { type: 'button', action: 'runScript', caption: 'Привет Васе',   params: { uid: clientUID, fn: 'sayHello',         fnParams: { name: 'Вася' } } },
                    { type: 'button', action: 'runScript', caption: 'Вася говорит',  params: { uid: clientUID, fn: 'say',              fnParams: { name: 'Вася', message: 'Как дела?' } } },
                    { type: 'button', action: 'runScript', caption: 'Статус брони',  params: { uid: clientUID, fn: 'showBookingStatus', fnParams: { bookingId: '{data.UID}' } } }
                ]
            }
        ];

        await layoutMemory.saveLayout({
            appName: 'uniRecordForm',
            tableName: 'bookings',
            roles: 'user',
            layout: bookingsLayout
        });

        console.log('[organizations/init] Custom layouts registered');
        console.log('[organizations/init] serverScriptName:', serverScriptName);
        console.log('[organizations/init] clientUID:', clientUID);
    } catch (e) {
        console.error('[organizations/init] Failed to register layouts:', e && e.message || e);
    }
};
