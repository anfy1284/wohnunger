const { Sequelize } = require('sequelize');
const s = require('./dbSettings.postgres.json');
const seq = new Sequelize(s.database, s.username, s.password, { host: s.host, port: s.port, dialect: 'postgres', logging: false });
seq.query(`SELECT u.*, us."roleId" FROM users u LEFT JOIN user_systems us ON u."UID" = us."userId" WHERE u.name = 'admin'`).then(r => { console.log(r[0]); seq.close(); });
