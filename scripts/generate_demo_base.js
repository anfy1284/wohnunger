const { Sequelize } = require('sequelize');
const dbSettings = require('../dbSettings.postgres.json');

const sequelize = new Sequelize(dbSettings.database, dbSettings.username, dbSettings.password, {
    host: dbSettings.host,
    port: dbSettings.port,
    dialect: dbSettings.dialect,
    logging: false
});

const orgId = "org-seiler-1";
const userId = "user-seiler-1";
const hotelId = "hotel-seiler-1";
const userOrgId = "uo-seiler-1";

const rooms = [
    { id: 'room-seiler-1', name: 'FeWo Nr. I' },
    { id: 'room-seiler-2', name: 'FeWo Nr. II' },
    { id: 'room-seiler-3', name: 'FeWo Nr. III' },
    { id: 'room-seiler-4', name: 'FeWo Nr. IV' }
];

const services = [
    { id: 'srv-breakfast', name: 'Frühstück', chargeType: 'per_night', taxRate: 19 },
    { id: 'srv-kurbeitrag', name: 'Kurbeitrag', chargeType: 'per_night', taxRate: 0 },
    { id: 'srv-cleaning', name: 'Endreinigung', chargeType: 'per_stay', taxRate: 7 },
    { id: 'srv-pet', name: 'Gebühr für den Hund', chargeType: 'per_night', taxRate: 7 },
    { id: 'srv-child', name: 'Kinderpreis (3-5 Jahre)', chargeType: 'per_night', taxRate: 7 }
];

const servicePrices = [
    // Завтраки
    { id: 'sp-bf-1', serviceId: 'srv-breakfast', ageFrom: 3, ageTo: 5, price: 3.5 },
    { id: 'sp-bf-2', serviceId: 'srv-breakfast', ageFrom: 6, ageTo: 13, price: 8.5 },
    { id: 'sp-bf-3', serviceId: 'srv-breakfast', ageFrom: 14, ageTo: 99, price: 14.5 },
    
    // Курортные сборы
    { id: 'sp-kb-1', serviceId: 'srv-kurbeitrag', ageFrom: 6, ageTo: 15, price: 1.0 },
    { id: 'sp-kb-2', serviceId: 'srv-kurbeitrag', ageFrom: 16, ageTo: 99, price: 2.1 },
    
    // Собака и ребенок
    { id: 'sp-pet-1', serviceId: 'srv-pet', ageFrom: null, ageTo: null, price: 10.0 },
    { id: 'sp-child-1', serviceId: 'srv-child', ageFrom: 3, ageTo: 5, price: 10.0 },
    
    // Уборка (привязана к комнатам)
    { id: 'sp-cl-1', serviceId: 'srv-cleaning', roomId: 'room-seiler-1', ageFrom: null, ageTo: null, price: 40.0 },
    { id: 'sp-cl-2', serviceId: 'srv-cleaning', roomId: 'room-seiler-2', ageFrom: null, ageTo: null, price: 60.0 },
    { id: 'sp-cl-3', serviceId: 'srv-cleaning', roomId: 'room-seiler-3', ageFrom: null, ageTo: null, price: 30.0 },
    { id: 'sp-cl-4', serviceId: 'srv-cleaning', roomId: 'room-seiler-4', ageFrom: null, ageTo: null, price: 30.0 }
];

const periods = [
    // Nebensaison Sommer
    { from: '2024-10-06', to: '2024-12-13', name: 'Nebensaison_Sommer' },
    { from: '2025-03-09', to: '2025-05-25', name: 'Nebensaison_Sommer' },
    { from: '2025-11-09', to: '2025-12-14', name: 'Nebensaison_Sommer' },
    { from: '2026-03-08', to: '2026-05-22', name: 'Nebensaison_Sommer' },
    { from: '2026-11-08', to: '2026-12-13', name: 'Nebensaison_Sommer' },
    { from: '2027-03-07', to: '2027-05-14', name: 'Nebensaison_Sommer' },
    
    // Hauptsaison
    { from: '2025-05-25', to: '2025-11-09', name: 'Hauptsaison' },
    { from: '2026-05-22', to: '2026-11-08', name: 'Hauptsaison' },
    { from: '2027-05-14', to: '2027-11-07', name: 'Hauptsaison' },
    
    // Nebensaison Winter
    { from: '2024-12-13', to: '2025-03-09', name: 'Nebensaison_Winter' },
    { from: '2025-12-14', to: '2026-03-08', name: 'Nebensaison_Winter' },
    { from: '2026-12-13', to: '2027-03-07', name: 'Nebensaison_Winter' }
];

const pricesBySeason = {
    'room-seiler-1': {
        'Nebensaison_Sommer': { 1: 74.0, 2: 86.0, 3: 109.5, 4: 134.0, 5: 157.5 },
        'Hauptsaison':        { 1: 83.0, 2: 93.0, 3: 120.0, 4: 144.0, 5: 167.5 },
        'Nebensaison_Winter': { 1: 86.0, 2: 101.0, 3: 127.5, 4: 154.0, 5: 180.0 }
    },
    'room-seiler-2': {
        'Nebensaison_Sommer': { 1: 84.0, 2: 97.0, 3: 114.0, 4: 139.0, 5: 162.5, 6: 186.0, 7: 210.0, 8: 234.0 },
        'Hauptsaison':        { 1: 91.0, 2: 104.0, 3: 129.0, 4: 154.0, 5: 180.0, 6: 204.0, 7: 231.0, 8: 254.0 },
        'Nebensaison_Winter': { 1: 97.0, 2: 112.0, 3: 138.0, 4: 164.0, 5: 190.0, 6: 216.0, 7: 241.0, 8: 268.0 }
    },
    'room-seiler-3': {
        'Nebensaison_Sommer': { 1: 56.0, 2: 69.0, 3: 88.5, 4: 106.0 },
        'Hauptsaison':        { 1: 63.0, 2: 77.0, 3: 97.5, 4: 116.0 },
        'Nebensaison_Winter': { 1: 70.0, 2: 85.0, 3: 105.0, 4: 126.0 }
    },
    'room-seiler-4': {
        'Nebensaison_Sommer': { 1: 56.0, 2: 69.0, 3: 88.5 },
        'Hauptsaison':        { 1: 63.0, 2: 77.0, 3: 97.5 },
        'Nebensaison_Winter': { 1: 70.0, 2: 85.0, 3: 105.0 }
    }
};

async function executeSql(query, params = []) {
    return sequelize.query(query, { replacements: params });
}

async function run() {
    try {
        await sequelize.authenticate();
        console.log('Подключено к базе данных. Начинаем заливку демо-данных...');

        const dateNow = new Date();

        // 1. Organization
        await executeSql(`
            INSERT INTO organizations ("UID", name, address, phone, email, "taxNumber", iban, bic, "createdAt", "updatedAt")
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT ("UID") DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address,
                phone = EXCLUDED.phone, email = EXCLUDED.email, "taxNumber" = EXCLUDED."taxNumber",
                iban = EXCLUDED.iban, bic = EXCLUDED.bic
        `, [orgId, 'Gästehaus Beim Seiler',
            'Breitenbergstr. 32, 87541 Hinterstein',
            '+49 8324 953440',
            'info@beim-seiler.de',
            '121/123/12345',
            'DE89 3704 0044 0532 0130 00',
            'COBADEFFXXX',
            dateNow, dateNow]);

        // 2. User (password: "123456")
        await executeSql(`
            INSERT INTO users ("UID", name, "organizationId", "password_hash", "createdAt", "updatedAt")
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT ("UID") DO UPDATE SET name = EXCLUDED.name, "password_hash" = EXCLUDED.password_hash
        `, [userId, 'Seiler', orgId, '$2b$10$nkN7VMznifV0CwpeJ9H4/.txMk6HYpSSO0zXEnNVVmO1psFKfn9te', dateNow, dateNow]);

        // 2.5 User-Organization Link
        await executeSql(`
            INSERT INTO user_organizations ("UID", "userId", "organizationId", "createdAt", "updatedAt")
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT ("UID") DO NOTHING
        `, [userOrgId, userId, orgId, dateNow, dateNow]);

        // 2.6 Framework specific: Add user to 'user_systems' to give them 'user' role in 'mySpace' system
        const userSystemId = "usys-seiler-1";
        const systemId = "000000000-sys_forms-0001"; // 'mySpace'
        const roleIdUser = "000000000-sys_forms-0005"; // 'user' (from defaultValues)
        
        await executeSql(`
            INSERT INTO user_systems ("UID", "userId", "systemId", "roleId", "createdAt", "updatedAt")
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT ("UID") DO UPDATE SET "roleId" = EXCLUDED."roleId"
        `, [userSystemId, userId, systemId, roleIdUser, dateNow, dateNow]);

        // 3. Hotel
        await executeSql(`
            INSERT INTO hotels ("UID", name, "organizationId", "createdAt", "updatedAt")
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT ("UID") DO UPDATE SET name = EXCLUDED.name
        `, [hotelId, 'Gästehaus Beim Seiler', orgId, dateNow, dateNow]);

        // Очищаем старые данные по ценам отеля (если были)
        await executeSql(`DELETE FROM service_prices WHERE "hotelId" = ?`, [hotelId]);
        await executeSql(`DELETE FROM room_prices WHERE "hotelId" = ?`, [hotelId]);
        await executeSql(`DELETE FROM rooms WHERE "hotelId" = ?`, [hotelId]);
        await executeSql(`DELETE FROM services WHERE "hotelId" = ?`, [hotelId]);

        // 4. Rooms
        for (const room of rooms) {
            await executeSql(`
                INSERT INTO rooms ("UID", number, "hotelId", "createdAt", "updatedAt")
                VALUES (?, ?, ?, ?, ?)
            `, [room.id, room.name, hotelId, dateNow, dateNow]);
        }

        // 5. Services
        for (const service of services) {
            await executeSql(`
                INSERT INTO services ("UID", "organizationId", "hotelId", name, "chargeType", "taxRate", "createdAt", "updatedAt")
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [service.id, orgId, hotelId, service.name, service.chargeType, service.taxRate, dateNow, dateNow]);
        }

        // 6. Service Prices
        for (const sp of servicePrices) {
            await executeSql(`
                INSERT INTO service_prices ("UID", "organizationId", "hotelId", "serviceId", "roomId", "ageFrom", "ageTo", price, "createdAt", "updatedAt")
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [sp.id, orgId, hotelId, sp.serviceId, sp.roomId || null, sp.ageFrom || null, sp.ageTo || null, sp.price, dateNow, dateNow]);
        }

        // 7. Room Prices (Генерация матрицы)
        for (const period of periods) {
            for (const room of rooms) {
                const roomGrid = pricesBySeason[room.id];
                if (!roomGrid) continue;

                const seasonPrices = roomGrid[period.name];
                if (!seasonPrices) continue;

                for (const guestsCountStr of Object.keys(seasonPrices)) {
                    const guestsCount = parseInt(guestsCountStr, 10);
                    const price = seasonPrices[guestsCountStr];
                    const rpId = `rp-${room.id}-${period.from}-${guestsCount}`;

                    await executeSql(`
                        INSERT INTO room_prices ("UID", "organizationId", "hotelId", "roomId", "dateFrom", "dateTo", "guestsCount", price, "taxRate", "createdAt", "updatedAt")
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [rpId, orgId, hotelId, room.id, period.from, period.to, guestsCount, price, 7, dateNow, dateNow]); // Tax 7 for base accommodation
                }
            }
        }

        console.log('Демо-база гостей "Gästehaus Beim Seiler" успешно сформирована!');
    } catch (e) {
        console.error('Ошибка при генерации базы:', e);
    } finally {
        await sequelize.close();
    }
}

run();