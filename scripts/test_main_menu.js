(async function(){
    try{
        const m = require('../node_modules/my-old-space/apps/main_menu/server.js');
        console.log('getDynamicMenu before:', JSON.stringify(m.getDynamicMenu(),null,2));
        const ids = m.addMenuItems([{id:'main', items:[{caption:'RunTest', action:'open', params:{}}]}], 'end');
        console.log('added ids', ids);
        const r = await m.getMainMenuCommands();
        console.log('getMainMenuCommands count=', r.length);
        console.log(JSON.stringify(r,null,2));
    }catch(e){
        console.error('test error', e && e.message || e);
    }
})();
