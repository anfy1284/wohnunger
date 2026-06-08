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
const crypto = require('crypto');

const SETTINGS_PATH = path.join(
    process.env.PROJECT_ROOT || path.join(__dirname, '..', '..', '..'),
    'ai_settings.json'
);

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_HISTORY_TURNS = 20;
const MAX_AUDIO_B64_LEN = 25 * 1024 * 1024;
const MAX_FACTS = 40;          // потолок числа фактов в долговременной памяти
const MAX_FACT_LEN = 300;      // максимальная длина одного факта
const BUFFER_MESSAGES = 16;    // сколько последних реплик клиент держит дословно

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
            description: 'Read the currently open form: table, field names with labels/types/current values, available buttons, and tabular sections (tables) with their columns. ALWAYS call this after open_form and before fill_field/add_table_row — names must match exactly.',
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
        },
        {
            name: 'find_records',
            description: 'Search a table for records whose name matches a query (case-insensitive). Use to look up the exact record for a reference field, or to browse. Returns matching records [{UID, name}].',
            parameters: {
                type: 'object',
                properties: {
                    table: { type: 'string', description: 'Table to search, e.g. "rooms", "clients"' },
                    query: { type: 'string', description: 'Text to search within the record name' },
                    limit: { type: 'integer', description: 'Max results (default 8)' }
                },
                required: ['table', 'query']
            }
        },
        {
            name: 'add_table_row',
            description: 'Add a row to a tabular section (a table inside the open form), e.g. a room, a guest line, a service, an extra line. Use the section table name and column names from read_form_state. Reference columns are resolved by name. Detail sections (e.g. guests/services that belong to a room) auto-link to the room — add the room row first.',
            parameters: {
                type: 'object',
                properties: {
                    table: { type: 'string', description: 'Tabular section table name from read_form_state, e.g. "booking_rooms", "booking_guests", "booking_extra_lines"' },
                    fields: {
                        type: 'array',
                        description: 'Column values for the new row. Reference columns take the human name (resolved automatically).',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'Column name, e.g. "roomId", "count"' },
                                value: { type: 'string', description: 'Value, e.g. "101", "Child", "3", "true"' }
                            },
                            required: ['name', 'value']
                        }
                    }
                },
                required: ['table', 'fields']
            }
        },
        {
            name: 'remove_table_row',
            description: 'Remove one row from a tabular section by its index (from read_form_state.tables[].rows[].index). Removing a master room also removes its linked guests/services. Use this (then add the right one) to correct or replace a row.',
            parameters: {
                type: 'object',
                properties: {
                    table: { type: 'string', description: 'Tabular section table name, e.g. "booking_rooms"' },
                    index: { type: 'integer', description: 'Row index from read_form_state' }
                },
                required: ['table', 'index']
            }
        },
        {
            name: 'clear_table',
            description: 'Remove ALL rows from a tabular section (e.g. to replace the whole set). Clearing rooms also clears linked guests/services.',
            parameters: {
                type: 'object',
                properties: {
                    table: { type: 'string', description: 'Tabular section table name' }
                },
                required: ['table']
            }
        },
        {
            name: 'remember',
            description: 'Save a DURABLE fact about the user to long-term memory: their name, how they want to be addressed, a lasting preference, or a correction/mapping they teach you (e.g. "the second apartment = FeWo Nr. II"). Keep it to one short sentence. Do NOT save transient details of a single booking.',
            parameters: {
                type: 'object',
                properties: { text: { type: 'string', description: 'The fact to remember, one concise sentence' } },
                required: ['text']
            }
        },
        {
            name: 'forget',
            description: 'Remove from long-term memory any fact containing the given text (use when a remembered fact is wrong or outdated).',
            parameters: {
                type: 'object',
                properties: { text: { type: 'string', description: 'Text identifying the fact(s) to remove' } },
                required: ['text']
            }
        },
        {
            name: 'list_windows',
            description: 'List the windows currently open on the screen (id, app, title, table). Use it to see what is open and to find a window to switch back to.',
            parameters: { type: 'object', properties: {} }
        },
        {
            name: 'focus_window',
            description: 'Make an already-open window the active form (and bring it to front), by its id from list_windows. Use it to return to a form you were working on (e.g. the booking) after opening another one.',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string', description: 'Window id from list_windows' } },
                required: ['id']
            }
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

// ── Долговременная память (на пользователя, RLS по userId) ──────────────
function userUID(ctx) { return (ctx && ctx.user && ctx.user.UID) ? ctx.user.UID : null; }

function getModel(modelsDB, name, table) {
    if (!modelsDB) return null;
    if (modelsDB[name]) return modelsDB[name];
    try { return Object.values(modelsDB).find(m => m && m.tableName === table) || null; }
    catch (e) { return null; }
}

async function loadMemory(modelsDB, ctx) {
    const uid = userUID(ctx);
    const M = getModel(modelsDB, 'AiChatMemory', 'ai_chat_memory');
    if (!uid || !M) return { summary: '', facts: [] };
    try {
        const row = await M.findOne({ where: { userId: uid }, raw: true });
        if (!row) return { summary: '', facts: [] };
        let facts = [];
        try { const a = JSON.parse(row.facts || '[]'); if (Array.isArray(a)) facts = a.map(String); } catch (_) {}
        return { summary: row.summary || '', facts };
    } catch (e) { return { summary: '', facts: [] }; }
}

async function saveMemory(modelsDB, ctx, patch) {
    const uid = userUID(ctx);
    const M = getModel(modelsDB, 'AiChatMemory', 'ai_chat_memory');
    if (!uid || !M) return;
    const data = {};
    if (patch.facts !== undefined) data.facts = JSON.stringify(Array.isArray(patch.facts) ? patch.facts.slice(-MAX_FACTS) : []);
    if (patch.summary !== undefined) data.summary = patch.summary;
    if (patch.summarizedCount !== undefined) data.summarizedCount = patch.summarizedCount;
    try {
        const row = await M.findOne({ where: { userId: uid } });
        if (row) {
            if (Object.keys(data).length) await row.update(data);
        } else {
            await M.create(Object.assign({ UID: crypto.randomUUID(), userId: uid, summary: '', facts: '[]', summarizedCount: 0 }, data));
        }
    } catch (e) { /* ignore persist errors */ }
}

// ── Буфер сообщений + сворачивание старого в пересказ (Фаза 2) ──────────
const KEEP_VERBATIM = BUFFER_MESSAGES;          // последние N сообщений — дословно
const SUMMARIZE_TRIGGER = KEEP_VERBATIM + 8;    // когда несвёрнутых станет больше — сворачиваем

async function appendMessage(modelsDB, ctx, role, text) {
    const uid = userUID(ctx);
    const M = getModel(modelsDB, 'AiChatMessages', 'ai_chat_messages');
    if (!uid || !M || !text) return;
    try { await M.create({ UID: crypto.randomUUID(), userId: uid, role: role, text: text }); } catch (e) {}
}

// Несвёрнутый «хвост» сообщений (то, что идёт в модель дословно).
async function loadBufferMessages(modelsDB, ctx) {
    const uid = userUID(ctx);
    const Mmsg = getModel(modelsDB, 'AiChatMessages', 'ai_chat_messages');
    const Mmem = getModel(modelsDB, 'AiChatMemory', 'ai_chat_memory');
    if (!uid || !Mmsg) return [];
    let summarizedCount = 0;
    try { const mr = Mmem && await Mmem.findOne({ where: { userId: uid }, raw: true }); summarizedCount = (mr && mr.summarizedCount) || 0; } catch (e) {}
    try {
        const rows = await Mmsg.findAll({ where: { userId: uid }, order: [['createdAt', 'ASC']], offset: summarizedCount, limit: 60, raw: true });
        return rows.map(r => ({ role: r.role, text: r.text }));
    } catch (e) { return []; }
}

async function summarizeViaLLM(prevSummary, rows) {
    const settings = readSettings();
    const apiKey = settings.geminiApiKey || '';
    const model = settings.geminiModel || DEFAULT_MODEL;
    if (!apiKey || !rows.length) return prevSummary;
    const convo = rows.map(r => (r.role === 'user' ? 'User: ' : 'Assistant: ') + (r.text || '')).join('\n');
    const prompt =
        'You maintain a running summary of an ongoing conversation between a hotel-booking assistant and a user. ' +
        'Merge the EXISTING summary with the NEW messages into ONE updated summary. ' +
        'Be concise (max ~1500 characters), factual; keep durable context, decisions and stated preferences; drop small talk. ' +
        'Write in the user\'s language.\n\nEXISTING SUMMARY:\n' + (prevSummary || '(none)') +
        '\n\nNEW MESSAGES:\n' + convo + '\n\nUPDATED SUMMARY:';
    const res = await callGemini(apiKey, model, { contents: [{ role: 'user', parts: [{ text: prompt }] }] });
    if (!res.ok) return prevSummary;
    const text = extractText(res.data).trim();
    return text ? text.slice(0, 2000) : prevSummary;
}

// Сворачивает самые старые несвёрнутые сообщения в summary, оставляя дословно последние KEEP.
async function maybeSummarize(modelsDB, ctx) {
    const uid = userUID(ctx);
    const Mmsg = getModel(modelsDB, 'AiChatMessages', 'ai_chat_messages');
    const Mmem = getModel(modelsDB, 'AiChatMemory', 'ai_chat_memory');
    if (!uid || !Mmsg || !Mmem) return;
    try {
        const total = await Mmsg.count({ where: { userId: uid } });
        const mr = await Mmem.findOne({ where: { userId: uid }, raw: true });
        const summarizedCount = (mr && mr.summarizedCount) || 0;
        if (total - summarizedCount <= SUMMARIZE_TRIGGER) return;     // ещё рано
        const foldTo = total - KEEP_VERBATIM;                        // дословно оставляем последние KEEP
        if (foldTo <= summarizedCount) return;
        const rows = await Mmsg.findAll({
            where: { userId: uid }, order: [['createdAt', 'ASC']],
            offset: summarizedCount, limit: foldTo - summarizedCount, raw: true
        });
        if (!rows.length) return;
        const newSummary = await summarizeViaLLM((mr && mr.summary) || '', rows.map(r => ({ role: r.role, text: r.text })));
        await saveMemory(modelsDB, ctx, { summary: newSummary, summarizedCount: foldTo });
    } catch (e) { /* ignore */ }
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

function buildAgentSystemInstruction(forms, memory) {
    const list = forms.length ? forms.map(f => '- ' + f.table + ' (' + f.caption + ')').join('\n') : '(none discovered)';
    const now = new Date();
    const todayISO = now.toISOString().slice(0, 10);
    let weekday = '';
    try { weekday = now.toLocaleDateString('en-US', { weekday: 'long' }); } catch (e) {}
    return [
        'You are an assistant embedded in a hotel booking management system with a Windows-95 style desktop UI.',
        'You can operate the UI for the user with tools: open forms, read the open form, fill fields, click buttons, save.',
        '',
        'Today is ' + todayISO + (weekday ? ' (' + weekday + ')' : '') + '. Resolve relative dates against today: never use a past year; if only a day (or day+month) is given, use the current year and month, or the next occurrence if that date already passed. Put dates into fields as YYYY-MM-DD.',
        'Do not put a value into an unrelated field (e.g. notes/comments) as a workaround for an action you cannot perform — instead state plainly what you could not do.',
        '',
        'How to fulfil a request:',
        '1. open_form for the relevant table (mode "record" with no recordId = create a new record).',
        '2. read_form_state to learn the EXACT field names, types and current values.',
        '3. fill_field for each needed field, using exact names from read_form_state.',
        '4. save_form (or click_button "save"/"ok") to persist.',
        'Always call read_form_state right after open_form, before filling. Do not invent field names.',
        '',
        'Reference fields: read_form_state marks some fields with reference:true and a refTable.',
        'Their stored value is an internal id, not human-readable. To set one, pass the human NAME',
        'to fill_field (e.g. a client name, a service name) — it is resolved to the record automatically.',
        'If fill_field reports ambiguous matches, call it again with a more specific/exact name.',
        'Use find_records(table, query) to look up the exact record when unsure.',
        '',
        'Tabular sections: read_form_state also lists the form\'s tables (e.g. rooms, guests, services) with their columns AND their current rows (each with an index).',
        'To add a line, call add_table_row with the section table name and column values (reference columns resolved by name).',
        'Detail sections (guests/services belong to a room) auto-link to the room, so add the room row first.',
        'Read the current rows before adding to avoid duplicates. To change/replace a row, use remove_table_row(table, index) or clear_table(table) and then add the correct one — NEVER add a second row to fix a wrong one.',
        '',
        'Working effectively:',
        '- A form stays open after every action and after save_form. Do NOT open_form again for the same record — keep operating on the already-open form (open_form only once per record). When the user corrects something, edit the CURRENT booking; do not start a new one.',
        '- Positions/ordinals ("the second room", "вторая") refer to records by their name/number (e.g. second → "FeWo Nr. II"). Map them yourself (use find_records to list options) and pick — do not repeatedly ask the user to restate it.',
        '- If a value is ambiguous, prefer making a reasonable choice from the candidates over asking again; only ask the user when genuinely necessary.',
        '- You can see what windows are open with list_windows and switch the active form with focus_window(id). Use this for multi-step work across several forms.',
        '- To use a record that does not exist yet (e.g. a NEW client), create it the same way a human would: open_form on that table, fill its fields, save_form — then switch back (focus_window) to the booking and reference the new record by name. There is no special "create" shortcut; use the normal forms.',
        '- The user may attach a file (image or PDF — e.g. a screenshot of a guest\'s booking request). When an attachment is present, read it and act on its content: extract guest name, dates, room, services, etc., create the booking, and confirm what you understood from the file.',
        'If a step fails, briefly explain and stop instead of guessing wildly.',
        '',
        'Openable forms (table — caption):',
        list,
        '',
        'What you remember about this user (long-term memory):',
        (memory && memory.facts && memory.facts.length) ? memory.facts.map(f => '- ' + f).join('\n') : '(nothing yet)',
        (memory && memory.summary) ? ('\nSummary of earlier conversation:\n' + memory.summary) : '',
        '',
        'You have long-term memory. When you learn a DURABLE fact about this user — their name, how they want to be addressed, a lasting preference, or a correction/mapping they teach you (e.g. "the second apartment means FeWo Nr. II") — call remember(text) with one short sentence. If a remembered fact is now wrong, call forget(text). Do not remember transient details of a single booking. When the user corrects a mistake, remember the corrected rule so you never repeat it.',
        'NEVER call forget on an instruction the user explicitly asked you to remember. If you cannot currently carry out a remembered instruction (e.g. there is no tool for it), KEEP it and tell the user plainly what you cannot do yet — do not silently remove it.',
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

        const userMessage = params && typeof params.userMessage === 'string' ? params.userMessage : '';
        const toolResults = Array.isArray(params && params.toolResults) ? params.toolResults : null;

        let history;
        if (userMessage) {
            // Начало хода: фиксируем реплику пользователя и собираем рабочую историю
            // из несвёрнутого «хвоста» (буфера) в БД — сервер владеет контекстом.
            await appendMessage(modelsDB, ctx, 'user', userMessage);
            const tail = await loadBufferMessages(modelsDB, ctx);
            history = tail.map(m => ({ role: m.role === 'ai' ? 'model' : 'user', parts: [{ text: m.text }] }));
            if (!history.length) history = [{ role: 'user', parts: [{ text: userMessage }] }];
            // Вложение (картинка/PDF) → добавляем как часть текущего сообщения пользователя,
            // чтобы модель «видела» файл (мультимодальность Gemini, как с аудио).
            const att = params && params.attachment;
            if (att && att.data && att.mimeType && String(att.data).length <= MAX_AUDIO_B64_LEN) {
                const last = history[history.length - 1];
                if (last && Array.isArray(last.parts)) last.parts.push({ inlineData: { mimeType: att.mimeType, data: att.data } });
            }
        } else {
            history = Array.isArray(params && params.history) ? params.history.slice() : [];
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
        }
        if (!history.length) return { ok: false, error: 'Empty agent step' };

        const forms = await getOpenableForms(ctx && ctx.sessionID);
        const memory = await loadMemory(modelsDB, ctx);
        const sys = buildAgentSystemInstruction(forms, memory);

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
        // Конец хода: сохраняем ответ ассистента и при необходимости сворачиваем старое в пересказ.
        try { await appendMessage(modelsDB, ctx, 'ai', text); await maybeSummarize(modelsDB, ctx); } catch (e) {}
        return { ok: true, done: true, text, history };
    },

    // ── Память / персистентность чата ───────────────────────────────────

    // Загрузка истории чата (для отображения) + памяти при открытии окна.
    async getConversation(params, ctx) {
        const uid = userUID(ctx);
        const memory = await loadMemory(modelsDB, ctx);
        let messages = [];
        const M = getModel(modelsDB, 'AiChatMessages', 'ai_chat_messages');
        if (uid && M) {
            try {
                const rows = await M.findAll({ where: { userId: uid }, order: [['createdAt', 'ASC']], limit: 200, raw: true });
                messages = rows.map(r => ({ role: r.role, text: r.text }));
            } catch (e) { /* ignore */ }
        }
        return { ok: true, messages, memory };
    },

    // Сохранение одного обмена (реплика пользователя + ответ ассистента).
    async appendTurn(params, ctx) {
        const uid = userUID(ctx);
        const M = getModel(modelsDB, 'AiChatMessages', 'ai_chat_messages');
        if (!uid || !M) return { ok: false };
        const userText = params && typeof params.userText === 'string' ? params.userText : '';
        const aiText = params && typeof params.aiText === 'string' ? params.aiText : '';
        try {
            if (userText) await M.create({ UID: crypto.randomUUID(), userId: uid, role: 'user', text: userText });
            if (aiText) await M.create({ UID: crypto.randomUUID(), userId: uid, role: 'ai', text: aiText });
            return { ok: true };
        } catch (e) { return { ok: false, error: String(e) }; }
    },

    // Записать факт в долговременную память (вызывается моделью).
    async remember(params, ctx) {
        const text = params && typeof params.text === 'string' ? params.text.trim().slice(0, MAX_FACT_LEN) : '';
        if (!text) return { ok: false, error: 'empty fact' };
        const mem = await loadMemory(modelsDB, ctx);
        if (!mem.facts.some(f => f.trim().toLowerCase() === text.toLowerCase())) mem.facts.push(text);
        await saveMemory(modelsDB, ctx, { facts: mem.facts });
        return { ok: true, remembered: text, factCount: mem.facts.length };
    },

    // Удалить факт(ы), содержащие указанный текст.
    async forget(params, ctx) {
        const needle = params && typeof params.text === 'string' ? params.text.trim().toLowerCase() : '';
        if (!needle) return { ok: false, error: 'empty' };
        const mem = await loadMemory(modelsDB, ctx);
        const before = mem.facts.length;
        mem.facts = mem.facts.filter(f => f.toLowerCase().indexOf(needle) === -1);
        await saveMemory(modelsDB, ctx, { facts: mem.facts });
        return { ok: true, removed: before - mem.facts.length };
    }
});
