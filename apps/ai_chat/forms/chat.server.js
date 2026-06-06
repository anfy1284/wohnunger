'use strict';

// ai_chat — серверный прокси к Google Gemini API.
// Ключ хранится ТОЛЬКО на сервере (ai_settings.json, git-ignored).
//   sendMessage — простой текстовый чат (без инструментов)
//   transcribe  — распознавание речи (аудио → текст) силами модели
//   agentStep   — один шаг агента с function calling: модель либо просит
//                 вызвать инструменты (открыть форму / заполнить поле / …),
//                 либо отвечает финальным текстом. Цикл крутит клиент.

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
const MAX_AUDIO_B64_LEN = 25 * 1024 * 1024;

const DEFAULT_SYSTEM_INSTRUCTION =
    'You are a helpful assistant integrated into a hotel booking management system. ' +
    'Answer concisely and reply in the same language the user writes in.';

const TRANSCRIBE_PROMPT =
    'Transcribe this audio recording verbatim. Return ONLY the transcription text — ' +
    'no quotes, no commentary, no language labels. ' +
    'If there is no discernible speech, return an empty string.';

// ── Инструменты агента (function declarations для Gemini) ───────────────
const AGENT_TOOLS = [{
    functionDeclarations: [
        {
            name: 'open_form',
            description: 'Open a form for a table. mode "record" = single-record form (omit recordId to CREATE NEW, pass recordId to edit existing); mode "list" = browser. Returns the form state (fields + buttons).',
            parameters: {
                type: 'object',
                properties: {
                    table: { type: 'string', description: 'Table name, e.g. "bookings"' },
                    mode: { type: 'string', enum: ['record', 'list'], description: 'record (default) or list' },
                    recordId: { type: 'string', description: 'UID of existing record to edit (record mode). Omit to create new.' }
                },
                required: ['table']
            }
        },
        {
            name: 'read_form_state',
            description: 'Read the currently open form: table, field names with labels/types/current values, and available buttons. ALWAYS call this after open_form and before fill_field — field names must match exactly.',
            parameters: { type: 'object', properties: {} }
        },
        {
            name: 'fill_field',
            description: 'Set a field value in the open form. Use the EXACT field name from read_form_state.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Exact field name from read_form_state' },
                    value: { type: 'string', description: 'Value. Dates as YYYY-MM-DD. Booleans as "true"/"false".' }
                },
                required: ['name', 'value']
            }
        },
        {
            name: 'click_button',
            description: 'Click a form button. action = "save", "ok" (save & close), "cancel" (close), or a custom button name from read_form_state.',
            parameters: {
                type: 'object',
                properties: { action: { type: 'string', description: 'Button action/name' } },
                required: ['action']
            }
        },
        {
            name: 'save_form',
            description: 'Save the open record form. Returns whether the save succeeded (and the new record id).',
            parameters: { type: 'object', properties: {} }
        }
    ]
}];

function readSettings() {
    try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
    catch (e) { return {}; }
}

function extractText(data) {
    const cand = data && data.candidates && data.candidates[0];
    const parts = cand && cand.content && cand.content.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
}

// Список форм, которые пользователь может открыть (из реестра главного меню,
// уже отфильтрованного по роли). Пункты uniForm + params.dbTable.
async function getOpenableForms(sessionID) {
    const out = [];
    const seen = new Set();
    try {
        const mainMenu = require('../../../node_modules/my-old-space/apps/main_menu/server.js');
        const tree = await mainMenu.getMainMenuCommands({}, sessionID);
        const walk = (arr) => {
            if (!Array.isArray(arr)) return;
            for (const it of arr) {
                if (it && it.appName === 'uniForm' && it.params && it.params.dbTable && !seen.has(it.params.dbTable)) {
                    seen.add(it.params.dbTable);
                    out.push({ table: it.params.dbTable, caption: typeof it.caption === 'string' ? it.caption : it.params.dbTable });
                }
                if (Array.isArray(it.items)) walk(it.items);
            }
        };
        walk(tree);
    } catch (e) { /* меню недоступно — вернём пустой список */ }
    return out;
}

function buildAgentSystemInstruction(forms) {
    const list = forms.length ? forms.map(f => '- ' + f.table + ' (' + f.caption + ')').join('\n') : '(none discovered)';
    return [
        'You are an assistant embedded in a hotel booking management system with a Windows-95 style desktop UI.',
        'You can operate the UI for the user with tools: open forms, read the open form, fill fields, click buttons, save.',
        '',
        'How to fulfil a request:',
        '1. open_form for the relevant table (mode "record" with no recordId = create a new record).',
        '2. read_form_state to learn the EXACT field names, types and current values.',
        '3. fill_field for each needed field, using exact names from read_form_state.',
        '4. save_form (or click_button "save"/"ok") to persist.',
        'Always call read_form_state right after open_form, before filling. Do not invent field names.',
        'If a step fails, briefly explain and stop instead of guessing wildly.',
        '',
        'Openable forms (table — caption):',
        list,
        '',
        'Reply to the user in the same language they used. Be concise. After acting, confirm briefly what you did.'
    ].join('\n');
}

// Единый вызов Gemini generateContent. Возвращает { ok, data } | { ok:false, error }.
async function callGemini(apiKey, model, payload) {
    const url = GEMINI_ENDPOINT + '/' + encodeURIComponent(model) +
        ':generateContent?key=' + encodeURIComponent(apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let httpResp, rawText;
    try {
        httpResp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
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
    try { data = rawText ? JSON.parse(rawText) : null; } catch (_) { /* non-JSON */ }

    if (!httpResp.ok) {
        const apiMsg = (data && data.error && data.error.message) || rawText || ('HTTP ' + httpResp.status);
        return { ok: false, error: 'Gemini API error (' + httpResp.status + '): ' + apiMsg };
    }
    return { ok: true, data };
}

module.exports = (modelsDB, Utilities) => ({

    // ── Простой текстовый чат (оставлен для совместимости) ──────────────
    async sendMessage(params, ctx) {
        const message = params && typeof params.message === 'string' ? params.message.trim() : '';
        const historyIn = Array.isArray(params && params.history) ? params.history : [];
        if (!message) return { ok: false, error: 'Empty message' };

        const settings = readSettings();
        const apiKey = settings.geminiApiKey || '';
        const model = settings.geminiModel || DEFAULT_MODEL;
        const systemInstruction = settings.systemInstruction || DEFAULT_SYSTEM_INSTRUCTION;
        if (!apiKey) return { ok: false, error: 'Gemini API key is not configured (ai_settings.json → geminiApiKey).' };

        const contents = [];
        for (const turn of historyIn.slice(-MAX_HISTORY_TURNS)) {
            if (!turn || typeof turn.text !== 'string' || !turn.text) continue;
            contents.push({ role: turn.role === 'ai' ? 'model' : 'user', parts: [{ text: turn.text }] });
        }
        contents.push({ role: 'user', parts: [{ text: message }] });

        const res = await callGemini(apiKey, model, {
            contents,
            systemInstruction: { parts: [{ text: systemInstruction }] }
        });
        if (!res.ok) return res;

        const reply = extractText(res.data);
        if (!reply) return { ok: false, error: 'Gemini returned no text.' };
        return { ok: true, reply };
    },

    // ── Распознавание речи (аудио → текст) ──────────────────────────────
    async transcribe(params, ctx) {
        const audioBase64 = params && typeof params.audioBase64 === 'string' ? params.audioBase64 : '';
        const mimeType = (params && params.mimeType) || 'audio/wav';
        if (!audioBase64) return { ok: false, error: 'No audio data' };
        if (audioBase64.length > MAX_AUDIO_B64_LEN) return { ok: false, error: 'Audio too large (max ~25MB). Record a shorter clip.' };

        const settings = readSettings();
        const apiKey = settings.geminiApiKey || '';
        const model = settings.geminiModel || DEFAULT_MODEL;
        if (!apiKey) return { ok: false, error: 'Gemini API key is not configured (ai_settings.json → geminiApiKey).' };

        const res = await callGemini(apiKey, model, {
            contents: [{
                role: 'user',
                parts: [
                    { text: TRANSCRIBE_PROMPT },
                    { inlineData: { mimeType, data: audioBase64 } }
                ]
            }]
        });
        if (!res.ok) return res;
        return { ok: true, transcript: extractText(res.data).trim() };
    },

    // ── Один шаг агента (function calling) ──────────────────────────────
    // params: { history: contents[], userMessage?: string, toolResults?: [{name, response}] }
    // returns: { ok, done, history, calls?: [{name,args}], text? } | { ok:false, error }
    async agentStep(params, ctx) {
        const settings = readSettings();
        const apiKey = settings.geminiApiKey || '';
        const model = settings.geminiModel || DEFAULT_MODEL;
        if (!apiKey) return { ok: false, error: 'Gemini API key is not configured (ai_settings.json → geminiApiKey).' };

        const history = Array.isArray(params && params.history) ? params.history.slice() : [];
        const userMessage = params && typeof params.userMessage === 'string' ? params.userMessage : '';
        const toolResults = Array.isArray(params && params.toolResults) ? params.toolResults : null;

        if (userMessage) {
            history.push({ role: 'user', parts: [{ text: userMessage }] });
        }
        if (toolResults) {
            history.push({
                role: 'user',
                parts: toolResults.map(r => ({
                    functionResponse: {
                        name: r.name,
                        response: (r.response && typeof r.response === 'object') ? r.response : { result: r.response }
                    }
                }))
            });
        }
        if (!history.length) return { ok: false, error: 'Empty agent step' };

        const forms = await getOpenableForms(ctx && ctx.sessionID);
        const sys = buildAgentSystemInstruction(forms);

        const res = await callGemini(apiKey, model, {
            contents: history,
            tools: AGENT_TOOLS,
            systemInstruction: { parts: [{ text: sys }] }
        });
        if (!res.ok) return res;

        const cand = res.data && res.data.candidates && res.data.candidates[0];
        const content = (cand && cand.content) ? cand.content : { role: 'model', parts: [] };
        if (!content.role) content.role = 'model';
        // Сохраняем весь turn модели (с thoughtSignature) — нужно для 2.5 thinking.
        history.push(content);

        const parts = Array.isArray(content.parts) ? content.parts : [];
        const calls = [];
        for (const p of parts) {
            if (p && p.functionCall && p.functionCall.name) {
                calls.push({ name: p.functionCall.name, args: p.functionCall.args || {} });
            }
        }

        if (calls.length) return { ok: true, done: false, calls, history };

        const text = parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('').trim();
        return { ok: true, done: true, text, history };
    }
});
