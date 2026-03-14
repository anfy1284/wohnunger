const fs = require('fs');
const path = require('path');

const paths = [
    "D:/wohnunger/node_modules/my-old-space/drive_forms/apps/tetris/db/db.json",
    "D:/wohnunger/node_modules/my-old-space/drive_forms/apps/login/db/db.json",
    "D:/wohnunger/node_modules/my-old-space/drive_forms/apps/calculator/db/db.json",
    "D:/wohnunger/node_modules/my-old-space/drive_forms/apps/messenger/db/db.json",
    "D:/wohnunger/node_modules/my-old-space/drive_forms/apps/taskbar/db/db.json",
    "D:/wohnunger/node_modules/my-old-space/drive_forms/apps/main_menu/db/db.json",
    "D:/wohnunger/node_modules/my-old-space/drive_forms/apps/cpp_app/db/db.json",
    "D:/wohnunger/node_modules/my-old-space/drive_forms/apps/fileSystem/db/db.json",
    "D:/wohnunger/node_modules/my-old-space/drive_forms/apps/UserSettings/db/db.json",
    "D:/wohnunger/node_modules/my-old-space/drive_forms/apps/uniListForm/db/db.json",
    "D:/wohnunger/node_modules/my-old-space/drive_forms/apps/uniRecordForm/db/db.json",
    "D:/wohnunger/node_modules/my-old-space/drive_forms/apps/listSettings/db/db.json",
    "D:/wohnunger/apps/organizations/db/db.json",
    "D:/wohnunger/node_modules/my-old-space/drive_root/db/db.json"
];

const uniqueModels = new Set();

paths.forEach(filePath => {
    if (fs.existsSync(filePath)) {
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (data.models && Array.isArray(data.models)) {
                data.models.forEach(model => {
                    const name = model.tableName || model.name;
                    if (name) {
                        uniqueModels.add(name);
                    }
                });
            }
        } catch (e) {
            console.error(`Error parsing ${filePath}: ${e.message}`);
        }
    }
});

console.log(JSON.stringify(Array.from(uniqueModels).sort(), null, 2));
