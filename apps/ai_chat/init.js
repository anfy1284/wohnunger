'use strict';

module.exports = async function (modelsDB) {
    try {
        const { loadServerScript, Utilities } = require('../../node_modules/my-old-space');
        loadServerScript('ai_chat.gemini', require('./forms/chat.server')(modelsDB, Utilities), 'user');
        console.log('[ai_chat/init] Server script registered');
    } catch (e) {
        console.error('[ai_chat/init] Failed:', e && e.message || e);
    }
};
