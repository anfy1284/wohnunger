'use strict';

// ai_chat — серверный прокси к Google Gemini API.
// Ключ хранится ТОЛЬКО на сервере (ai_settings.json, git-ignored) и
// никогда не отдаётся клиенту. Клиент вызывает sendMessage через callServer.

const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(
    process.env.PROJECT_ROOT || path.join(__dirname, '..', '..', '..'),
    'ai_settings.json'
);

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_HISTORY_TURNS = 20;

const DEFAULT_SYSTEM_INSTRUCTION =
    'You are a helpful assistant integrated into a hotel booking management system. ' +
    'Answer concisely and reply in the same language the user writes in.';

function readSettings() {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch (e) {
        return {};
    }
}

module.exports = (modelsDB, Utilities) => ({

    // params: { message: string, history?: [{ role: 'user'|'ai', text: string }] }
    // returns: { ok: true, reply } | { ok: false, error }
    async sendMessage(params, ctx) {
        const message = params && typeof params.message === 'string' ? params.message.trim() : '';
        const historyIn = Array.isArray(params && params.history) ? params.history : [];

        if (!message) return { ok: false, error: 'Empty message' };

        const settings = readSettings();
        const apiKey = settings.geminiApiKey || '';
        const model = settings.geminiModel || DEFAULT_MODEL;
        const systemInstruction = settings.systemInstruction || DEFAULT_SYSTEM_INSTRUCTION;

        if (!apiKey) {
            return { ok: false, error: 'Gemini API key is not configured (ai_settings.json → geminiApiKey).' };
        }

        // Собираем contents: ограниченная история + текущее сообщение.
        const contents = [];
        for (const turn of historyIn.slice(-MAX_HISTORY_TURNS)) {
            if (!turn || typeof turn.text !== 'string' || !turn.text) continue;
            contents.push({
                role: turn.role === 'ai' ? 'model' : 'user',
                parts: [{ text: turn.text }]
            });
        }
        contents.push({ role: 'user', parts: [{ text: message }] });

        const url = GEMINI_ENDPOINT + '/' + encodeURIComponent(model) +
            ':generateContent?key=' + encodeURIComponent(apiKey);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        let httpResp, rawText;
        try {
            httpResp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents,
                    systemInstruction: { parts: [{ text: systemInstruction }] }
                }),
                signal: controller.signal
            });
            rawText = await httpResp.text();
        } catch (e) {
            clearTimeout(timer);
            if (e && e.name === 'AbortError') {
                return { ok: false, error: 'Gemini request timed out (' + (REQUEST_TIMEOUT_MS / 1000) + 's).' };
            }
            return { ok: false, error: 'Network error contacting Gemini: ' + (e && e.message || String(e)) };
        }
        clearTimeout(timer);

        let data = null;
        try { data = rawText ? JSON.parse(rawText) : null; } catch (_) { /* non-JSON body */ }

        if (!httpResp.ok) {
            const apiMsg = (data && data.error && data.error.message) || rawText || ('HTTP ' + httpResp.status);
            return { ok: false, error: 'Gemini API error (' + httpResp.status + '): ' + apiMsg };
        }

        const candidate = data && data.candidates && data.candidates[0];
        const parts = candidate && candidate.content && candidate.content.parts;
        let reply = '';
        if (Array.isArray(parts)) {
            reply = parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
        }

        if (!reply) {
            const reason = (candidate && candidate.finishReason) ||
                           (data && data.promptFeedback && data.promptFeedback.blockReason) ||
                           'no content';
            return { ok: false, error: 'Gemini returned no text (' + reason + ').' };
        }

        return { ok: true, reply };
    }
});
