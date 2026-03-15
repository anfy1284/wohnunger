const path = require('path');
const globalCtx = require('./node_modules/my-old-space/drive_root/globalServerContext');

async function test() {
    process.env.PROJECT_ROOT = __dirname;
    globalCtx.setProjectRoot(__dirname);
    setTimeout(async () => {
        try {
            const dbg = require('./dbGateway');
            // Mock next
            const next = async (req) => { return await dbg.execute({ ...req, context: Object.assign({}, req.context, { skipMiddlewares: true }) }) };
            
            console.log('\n--- Admin Test ---');
            const res1 = await dbg.execute({ 
                operation: 'read', 
                table: 'organizations', 
                context: { userId: '000000000-organizations-0001' } 
            });
            console.log('Got orgs for Admin:', res1.length);
            
            console.log('\n--- Seiler Test ---');
            const res2 = await dbg.execute({ 
                operation: 'read', 
                table: 'organizations', 
                context: { userId: 'user-seiler-1' }
            });
            console.log('Got orgs for Seiler:', res2.length);

        } catch(e) { console.error(e) }

        process.exit(0);
    }, 2000);
}
test();