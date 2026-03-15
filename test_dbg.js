const path = require('path');
const globalCtx = require('./node_modules/my-old-space/drive_root/globalServerContext');

async function test() {
    process.env.PROJECT_ROOT = __dirname; // Very important
    await globalCtx.initModelsDB(__dirname); // Load all project models
    try {
        const globalForms = require('./node_modules/my-old-space/drive_forms/globalServerContext');
        const role = await globalForms.getUserAccessRole({ UID: 'user-seiler-1' });
        console.log('Seiler role:', role);
        
        const adminRole = await globalForms.getUserAccessRole({ UID: '000000000-organizations-0001' });
        console.log('Admin role:', adminRole);

        const dbg = require('./dbGateway');
        const res = await dbg.execute({ 
            operation: 'read', 
            table: 'organizations', 
            context: { userId: 'user-seiler-1' } // Simulating frontend API where role is missing!
        });
        console.log('Organizations for Seiler:', res.map(r => r.get({plain: true})));

        const res2 = await dbg.execute({ 
            operation: 'read', 
            table: 'organizations', 
            context: { userId: '000000000-organizations-0001' } // Simulating frontend API where role is missing!
        });
        console.log('Organizations for Admin:', res2.map(r => r.get({plain: true})));

    } catch (e) {
        console.error('Error:', e);
    }
}
test();
