const fs = require('fs');
const path = require('path');

const filesToScan = [
    'D:/wohnunger/apps/organizations/db/db.json',
    'D:/wohnunger/node_modules/my-old-space/drive_root/db/db.json',
    'D:/wohnunger/node_modules/my-old-space/drive_forms/db/db.json',
    'D:/wohnunger/node_modules/my-old-space/apps/fileSystem/db/db.json',
    'D:/wohnunger/node_modules/my-old-space/apps/main_menu/db/db.json',
    'D:/wohnunger/node_modules/my-old-space/apps/messenger/db/db.json'
];

const tableNames = new Set();

filesToScan.forEach(filePath => {
    if (fs.existsSync(filePath)) {
        try {
            const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (content.models && Array.isArray(content.models)) {
                content.models.forEach(model => {
                    const name = model.tableName || model.name;
                    if (name) {
                        tableNames.add(name);
                    }
                });
            }
        } catch (e) {
            console.error(`Error processing ${filePath}: ${e.message}`);
        }
    }
});

console.log(JSON.stringify(Array.from(tableNames).sort(), null, 2));
