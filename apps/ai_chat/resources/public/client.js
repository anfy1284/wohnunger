/**
 * ai_chat — ИИ-ассистент, который управляет интерфейсом (открывает формы,
 * заполняет поля, жмёт кнопки) + текстовый и голосовой ввод.
 *
 *   Текст/голос → агентный цикл:
 *     client → callServer('ai_chat.gemini','agentStep') → Gemini (function calling)
 *       • Gemini просит вызвать инструмент → BotAPI выполняет его в браузере
 *         (MySpace.open / DataForm.controlsMap / doAction) → результат назад в модель
 *       • повторяем, пока модель не вернёт финальный текст
 *   Голос: запись микрофона (Web Audio) → WAV → 'transcribe' (Gemini) → текст в поле.
 *
 * BotAPI работает в сессии залогиненного пользователя — RLS в dbGateway.js
 * автоматически ограничивает агента правами этого пользователя.
 */

MySpace.register('ai_chat', {
    config: { allowMultipleInstances: false },

    createInstance: async function (params) {
        const APP_NAME = 'ai_chat';
        const SERVER_SCRIPT = 'ai_chat.gemini';
        const MAX_REC_MS = 45000;
        const TARGET_RATE = 16000;
        const MAX_AGENT_STEPS = 16;        // предохранитель от зацикливания

        // ── DataForm — стандартный контейнер формы ──────────────────────
        const appForm = new DataForm(APP_NAME);
        appForm.setTitle(__t('AI Assistant'));
        appForm.setWidth(560);
        appForm.setHeight(620);
        appForm.setAnchorToWindow('center');

        appForm.getLayoutWithData = async function () {
            return { layout: [], data: [], datasetId: null };
        };

        // ── Внутреннее состояние ─────────────────────────────────────────
        let _messagesArea = null;
        let _inputControl = null;
        let _sendBtn = null;
        let _micBtn = null;
        let agentHistory = [];             // contents[] в формате Gemini (растёт по ходу диалога)

        // Голосовой ввод (запись)
        let _recording = false;
        let _busy = false;
        let _voiceBaseText = '';
        let _audioCtx = null;
        let _mediaStream = null;
        let _sourceNode = null;
        let _procNode = null;
        let _zeroGain = null;
        let _pcmChunks = [];
        let _pcmLen = 0;
        let _recSampleRate = 0;
        let _maxRecTimer = null;

        // ── Draw: окно + UI чата ─────────────────────────────────────────
        const _originalDraw = appForm.Draw.bind(appForm);

        appForm.Draw = async function (parent) {
            await _originalDraw(parent);

            const contentArea = this.getContentArea();
            if (!contentArea) return;

            contentArea.style.gap = '6px';
            contentArea.style.padding = '8px';

            _messagesArea = document.createElement('div');
            _messagesArea.style.flex = '1 1 auto';
            _messagesArea.style.overflowY = 'auto';
            _messagesArea.style.overflowX = 'hidden';
            _messagesArea.style.backgroundColor = '#ffffff';
            _messagesArea.style.borderTop = '2px solid #808080';
            _messagesArea.style.borderLeft = '2px solid #808080';
            _messagesArea.style.borderRight = '2px solid #ffffff';
            _messagesArea.style.borderBottom = '2px solid #ffffff';
            _messagesArea.style.padding = '6px';
            _messagesArea.style.boxSizing = 'border-box';
            contentArea.appendChild(_messagesArea);

            const inputRow = document.createElement('div');
            inputRow.style.display = 'flex';
            inputRow.style.flexShrink = '0';
            inputRow.style.height = '68px';
            inputRow.style.gap = '6px';
            contentArea.appendChild(inputRow);

            _inputControl = new MultilineTextBox(inputRow);
            _inputControl.setPlaceholder(__t('Enter message... (Ctrl+Enter — send)'));
            _inputControl.Draw(inputRow);

            if (_inputControl.element) {
                _inputControl.element.style.flex = '1 1 auto';
                _inputControl.element.style.width = 'auto';
                _inputControl.element.style.height = '100%';
                _inputControl.element.style.resize = 'none';
                _inputControl.element.style.boxSizing = 'border-box';
                _inputControl.element.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); sendMessage(); }
                });
            }

            _micBtn = new Button(inputRow);
            _micBtn.setIcon('/apps/general_icons/resources/public/16x16/microphone.png');
            _micBtn.setWidth(40);
            _micBtn.Draw(inputRow);
            if (_micBtn.element) {
                _micBtn.element.style.height = '100%';
                _micBtn.element.style.flexShrink = '0';
                _micBtn.element.style.alignSelf = 'stretch';
                _micBtn.element.style.boxSizing = 'border-box';
                _micBtn.element.title = __t('Voice input');
                if (!recordingSupported()) _micBtn.element.style.display = 'none';
            }
            _micBtn.onClick = function () { toggleVoice(); };

            _sendBtn = new Button(inputRow);
            _sendBtn.setCaption(__t('Send'));
            _sendBtn.setIcon('/apps/general_icons/resources/public/16x16/send.png');
            _sendBtn.setWidth(90);
            _sendBtn.Draw(inputRow);
            if (_sendBtn.element) {
                _sendBtn.element.style.height = '100%';
                _sendBtn.element.style.flexShrink = '0';
                _sendBtn.element.style.alignSelf = 'stretch';
                _sendBtn.element.style.boxSizing = 'border-box';
            }
            _sendBtn.onClick = function () { sendMessage(); };

            addMessage('system', __t('Connected to Google Gemini. Ask in words or by voice — e.g. «open a new booking and fill in the dates».'));
            if (_inputControl && _inputControl.element) { try { _inputControl.element.focus(); } catch (_) {} }
        };

        // ─────────────────────────────────────────────────────────────────
        // Сообщения
        // ─────────────────────────────────────────────────────────────────

        function addMessage(role, text) {
            if (!_messagesArea) return null;
            const div = document.createElement('div');
            div.style.marginBottom = '6px';
            div.style.padding = '5px 8px';
            div.style.wordBreak = 'break-word';
            div.style.lineHeight = '1.4';
            div.style.fontFamily = 'MS Sans Serif, sans-serif';
            div.style.fontSize = '11px';

            if (role === 'user') {
                div.style.backgroundColor = '#dde8f5';
                div.style.borderLeft = '3px solid #5a8fc0';
            } else if (role === 'ai') {
                div.style.backgroundColor = '#f0f0f0';
                div.style.borderLeft = '3px solid #8a8a8a';
            } else if (role === 'tool') {
                div.style.color = '#3a6ea5';
                div.style.fontFamily = 'monospace';
                div.style.fontSize = '10px';
                div.style.background = '#f6f8fb';
            } else {
                div.style.color = '#666666';
                div.style.fontStyle = 'italic';
                div.style.textAlign = 'center';
                div.style.fontSize = '10px';
            }

            if (role === 'user' || role === 'ai') {
                const nameSpan = document.createElement('span');
                nameSpan.style.fontWeight = 'bold';
                nameSpan.style.display = 'block';
                nameSpan.style.marginBottom = '2px';
                nameSpan.style.fontSize = '10px';
                nameSpan.style.color = role === 'user' ? '#336699' : '#555555';
                nameSpan.textContent = role === 'user' ? __t('You') : __t('AI');
                div.appendChild(nameSpan);
            }

            const textSpan = document.createElement('span');
            textSpan.style.whiteSpace = 'pre-wrap';
            textSpan.textContent = text;
            div.appendChild(textSpan);

            _messagesArea.appendChild(div);
            _messagesArea.scrollTop = _messagesArea.scrollHeight;
            return { div, textSpan };
        }

        function removeMessage(msg) {
            if (msg && msg.div && msg.div.parentNode) msg.div.parentNode.removeChild(msg.div);
        }

        function setInputEnabled(enabled) {
            if (_sendBtn && _sendBtn.element) _sendBtn.element.disabled = !enabled;
            if (_inputControl && _inputControl.element) _inputControl.element.disabled = !enabled;
        }

        // ═════════════════════════════════════════════════════════════════
        // BotAPI — выполнение инструментов агента в браузере
        // ═════════════════════════════════════════════════════════════════
        const BotAPI = {
            _instanceId: null,
            _form: null,

            async execute(name, args) {
                if (typeof this[name] !== 'function') return { error: 'unknown tool: ' + name };
                try { return await this[name](args || {}); }
                catch (e) { return { error: (e && e.message) || String(e) }; }
            },

            async open_form(args) {
                const table = args.table;
                if (!table) return { error: 'table is required' };
                const mode = args.mode || 'record';
                const p = (mode === 'list') ? { mode: 'list', dbTable: table } : { mode: 'record', tableName: table };
                if (mode === 'record' && args.recordId) p.recordID = args.recordId;

                if (!(window.MySpace && typeof window.MySpace.open === 'function')) return { error: 'MySpace.open unavailable' };
                let id;
                try { id = await window.MySpace.open('uniForm', p); }
                catch (e) { return { error: 'open failed: ' + (e && e.message || String(e)) }; }

                const inst = window.MySpace.getInstance ? window.MySpace.getInstance(id) : null;
                const form = inst && inst.form ? inst.form : null;
                if (!form) return { error: 'form instance not found' };
                this._instanceId = id;
                this._form = form;

                const ready = await waitForForm(form, 8000);
                const state = this.read_form_state();
                if (!ready && state && state.ok) state.warning = 'form may still be loading';
                return state;
            },

            read_form_state() {
                const form = this._form;
                if (!form) return { error: 'no open form — call open_form first' };
                const table = form.dbTable || form.tableName || null;

                const values = (typeof form.collectData === 'function') ? form.collectData() : {};
                const meta = {};
                collectLayoutFields(form.layout, meta);

                const fields = [];
                for (const fname in values) {
                    const m = meta[fname] || {};
                    fields.push({ name: fname, label: m.label || fname, type: m.type || 'text', value: values[fname] });
                }
                const buttons = collectLayoutButtons(form.layout);
                return { ok: true, table, fields, buttons };
            },

            fill_field(args) {
                const form = this._form;
                if (!form) return { error: 'no open form' };
                const name = args.name;
                if (!name) return { error: 'name is required' };
                const ctrl = form.controlsMap && form.controlsMap[name];
                if (!ctrl) return { error: 'field not found: ' + name + ' (use read_form_state for exact names)' };

                let value = (args.value !== undefined) ? args.value : '';
                try {
                    if (ctrl.element && ctrl.element.type === 'checkbox') {
                        ctrl.element.checked = (value === true || value === 'true' || value === '1' || value === 1);
                        ctrl.element.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if (typeof ctrl.setValue === 'function') {
                        ctrl.setValue(value);
                    } else if (typeof ctrl.setText === 'function') {
                        ctrl.setText(value);
                    } else if (ctrl.element) {
                        ctrl.element.value = value;
                        ctrl.element.dispatchEvent(new Event('input', { bubbles: true }));
                        ctrl.element.dispatchEvent(new Event('change', { bubbles: true }));
                    } else {
                        return { error: 'cannot set this field type' };
                    }
                    try { if (typeof form.setModified === 'function') form.setModified(true); } catch (_) {}
                } catch (e) {
                    return { error: 'set failed: ' + (e && e.message || String(e)) };
                }

                let newVal;
                try { newVal = (typeof ctrl.getValue === 'function') ? ctrl.getValue() : (ctrl.element ? ctrl.element.value : value); }
                catch (_) { newVal = value; }
                return { ok: true, name, value: newVal };
            },

            async save_form() {
                const form = this._form;
                if (!form) return { error: 'no open form' };
                try {
                    const data = (typeof form.collectData === 'function') ? form.collectData() : {};
                    // табличные части — как в DataForm.doAction('save')
                    try {
                        const ts = {};
                        if (form._dataMap) {
                            for (const k in form._dataMap) {
                                const e = form._dataMap[k];
                                if (e && e.tabularSection === true) ts[e.tableName] = Array.isArray(e.value) ? e.value : [];
                            }
                        }
                        if (Object.keys(ts).length) data.__tabularSections = ts;
                    } catch (_) {}

                    if (typeof form.applyChanges !== 'function') return { error: 'form has no applyChanges' };
                    const res = await form.applyChanges(data);
                    if (res && res.ok) {
                        try { if (typeof form.setModified === 'function') form.setModified(false); } catch (_) {}
                        return { ok: true, saved: true, recordId: res.recordId, warnings: res.warnings || [] };
                    }
                    return { ok: false, error: (res && (res.error || res.message)) || 'save failed', warnings: (res && res.warnings) || [] };
                } catch (e) {
                    return { error: 'save failed: ' + (e && e.message || String(e)) };
                }
            },

            async click_button(args) {
                const form = this._form;
                if (!form) return { error: 'no open form' };
                const action = args.action;
                if (!action) return { error: 'action is required' };

                if (action === 'save') return this.save_form();

                if (action === 'ok') {
                    const r = await this.save_form();
                    if (r && r.ok) { try { form.close(); } catch (_) {} }
                    return r;
                }
                if (action === 'cancel') {
                    try { form._modified = false; if (typeof form.close === 'function') form.close(); } catch (_) {}
                    return { ok: true, action: 'cancel' };
                }

                // кастомная именованная кнопка
                const btn = form.controlsMap && form.controlsMap[action];
                if (btn && typeof btn.onClick === 'function') { try { btn.onClick(); return { ok: true, action }; } catch (e) { return { error: String(e) }; } }
                if (typeof form.doAction === 'function') { try { await form.doAction(action); return { ok: true, action }; } catch (e) { return { error: String(e) }; } }
                return { error: 'button not found: ' + action };
            }
        };

        // ── Утилиты чтения лейаута формы ─────────────────────────────────
        const CONTAINER_TYPES = ['commandBar', 'button', 'table', 'tabs', 'group', 'panel', 'column', 'columns', 'row', 'section', 'fieldset'];

        function resolveCaption(cap) {
            if (!cap) return null;
            if (typeof cap === 'string') return cap;
            if (typeof cap === 'object') return cap.i18n || cap.text || null;
            return null;
        }

        function collectLayoutFields(layout, meta) {
            if (!Array.isArray(layout)) return;
            for (const item of layout) {
                if (!item || typeof item !== 'object') continue;
                if (item.name && CONTAINER_TYPES.indexOf(item.type) === -1) {
                    meta[item.name] = {
                        label: resolveCaption(item.caption) || resolveCaption(item.label) || item.name,
                        type: item.type || 'text'
                    };
                }
                if (Array.isArray(item.items)) collectLayoutFields(item.items, meta);
                if (Array.isArray(item.columns)) collectLayoutFields(item.columns, meta);
                if (Array.isArray(item.children)) collectLayoutFields(item.children, meta);
                if (Array.isArray(item.tabs)) for (const tab of item.tabs) { if (tab && Array.isArray(tab.items)) collectLayoutFields(tab.items, meta); }
            }
        }

        function collectLayoutButtons(layout) {
            const btns = [];
            const walk = (arr) => {
                if (!Array.isArray(arr)) return;
                for (const item of arr) {
                    if (!item || typeof item !== 'object') continue;
                    if (item.type === 'commandBar') {
                        const hidden = Array.isArray(item.hiddenButtons) ? item.hiddenButtons : [];
                        ['ok', 'save', 'cancel'].forEach(s => { if (hidden.indexOf(s) === -1) btns.push(s); });
                        if (Array.isArray(item.extraButtons)) item.extraButtons.forEach(e => { if (e && e.name) btns.push(e.name); });
                    } else if (item.type === 'button' && (item.name || item.action)) {
                        btns.push(item.name || item.action);
                    }
                    if (Array.isArray(item.items)) walk(item.items);
                    if (Array.isArray(item.columns)) walk(item.columns);
                    if (Array.isArray(item.tabs)) for (const tab of item.tabs) { if (tab && Array.isArray(tab.items)) walk(tab.items); }
                }
            };
            walk(layout);
            return btns;
        }

        // Ждём, пока форма отрисуется (Draw в uniForm не await'ится).
        function waitForForm(form, timeoutMs) {
            return new Promise((resolve) => {
                const start = Date.now();
                (function poll() {
                    const hasControls = form && form.controlsMap && Object.keys(form.controlsMap).length > 0;
                    const hasLayout = form && Array.isArray(form.layout) && form.layout.length > 0;
                    if (hasControls || hasLayout) { setTimeout(() => resolve(true), 200); return; }
                    if (Date.now() - start > timeoutMs) { resolve(false); return; }
                    setTimeout(poll, 120);
                })();
            });
        }

        // ═════════════════════════════════════════════════════════════════
        // Агентный цикл
        // ═════════════════════════════════════════════════════════════════
        function logToolCall(call) {
            const a = call.args || {};
            let detail = '';
            if (call.name === 'open_form') detail = a.table + (a.mode ? (' [' + a.mode + ']') : '');
            else if (call.name === 'fill_field') detail = a.name + ' = ' + a.value;
            else if (call.name === 'click_button') detail = a.action;
            addMessage('tool', '→ ' + call.name + (detail ? (': ' + detail) : ''));
        }

        async function runAgent(userText) {
            const pending = addMessage('ai', '…');
            setInputEnabled(false);
            let step = { userMessage: userText };
            let guard = 0;

            try {
                while (true) {
                    if (++guard > MAX_AGENT_STEPS) {
                        pending.textSpan.textContent = __t('⚠ Too many steps, stopping.');
                        break;
                    }
                    const resp = await callServer(SERVER_SCRIPT, 'agentStep', Object.assign({ history: agentHistory }, step));

                    if (!resp || !resp.ok) {
                        pending.div.style.color = '#a00000';
                        pending.textSpan.textContent = __t('Error: ') + ((resp && resp.error) || __t('unknown error'));
                        break;
                    }
                    agentHistory = resp.history || agentHistory;

                    if (resp.done) {
                        pending.textSpan.textContent = resp.text || '✓';
                        break;
                    }

                    const results = [];
                    for (const call of (resp.calls || [])) {
                        logToolCall(call);
                        const r = await BotAPI.execute(call.name, call.args || {});
                        results.push({ name: call.name, response: r });
                    }
                    step = { toolResults: results };
                    if (_messagesArea) _messagesArea.scrollTop = _messagesArea.scrollHeight;
                }
            } catch (e) {
                pending.div.style.color = '#a00000';
                pending.textSpan.textContent = __t('Error: ') + (e && e.message ? e.message : String(e));
            } finally {
                setInputEnabled(true);
                if (_messagesArea) _messagesArea.scrollTop = _messagesArea.scrollHeight;
                if (_inputControl && _inputControl.element) { try { _inputControl.element.focus(); } catch (_) {} }
            }
        }

        async function sendMessage() {
            if (!_inputControl || !_inputControl.getText) return;
            if (_recording) stopVoiceAndTranscribe();

            const rawText = _inputControl.getText();
            const text = rawText ? rawText.trim() : '';
            if (!text) return;

            _inputControl.setText('');
            addMessage('user', text);
            await runAgent(text);
        }

        // ═════════════════════════════════════════════════════════════════
        // Голосовой ввод: запись микрофона → WAV → сервер ('transcribe')
        // ═════════════════════════════════════════════════════════════════
        function recordingSupported() {
            return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
                      (window.AudioContext || window.webkitAudioContext));
        }

        function toggleVoice() {
            if (_busy) return;
            if (_recording) stopVoiceAndTranscribe();
            else startVoice();
        }

        async function startVoice() {
            if (_recording) return;
            try {
                _mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (e) {
                addMessage('system', __t('Microphone access denied.'));
                return;
            }
            const Ctx = window.AudioContext || window.webkitAudioContext;
            _audioCtx = new Ctx();
            try { await _audioCtx.resume(); } catch (_) {}
            _recSampleRate = _audioCtx.sampleRate;

            _sourceNode = _audioCtx.createMediaStreamSource(_mediaStream);
            _procNode = _audioCtx.createScriptProcessor(4096, 1, 1);
            _pcmChunks = [];
            _pcmLen = 0;
            _procNode.onaudioprocess = function (e) {
                const ch = e.inputBuffer.getChannelData(0);
                _pcmChunks.push(new Float32Array(ch));
                _pcmLen += ch.length;
            };
            _zeroGain = _audioCtx.createGain();
            _zeroGain.gain.value = 0;
            _sourceNode.connect(_procNode);
            _procNode.connect(_zeroGain);
            _zeroGain.connect(_audioCtx.destination);

            _voiceBaseText = (_inputControl && _inputControl.getText) ? (_inputControl.getText() || '').trim() : '';
            setMicState(true);
            _maxRecTimer = setTimeout(function () { if (_recording) stopVoiceAndTranscribe(); }, MAX_REC_MS);
        }

        function teardownAudio() {
            if (_maxRecTimer) { clearTimeout(_maxRecTimer); _maxRecTimer = null; }
            try { if (_procNode) _procNode.disconnect(); } catch (_) {}
            try { if (_sourceNode) _sourceNode.disconnect(); } catch (_) {}
            try { if (_zeroGain) _zeroGain.disconnect(); } catch (_) {}
            if (_mediaStream) { try { _mediaStream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {} }
            if (_audioCtx) { try { _audioCtx.close(); } catch (_) {} }
            _procNode = _sourceNode = _zeroGain = _mediaStream = _audioCtx = null;
        }

        async function stopVoiceAndTranscribe() {
            if (!_recording) return;
            setMicState(false);

            const chunks = _pcmChunks;
            const total = _pcmLen;
            const sr = _recSampleRate;
            teardownAudio();
            _pcmChunks = [];
            _pcmLen = 0;
            if (!total) return;

            let samples = mergeChunks(chunks, total);
            const ds = downsample(samples, sr, TARGET_RATE);
            const wavBytes = encodeWAV(ds.data, ds.rate);
            const b64 = bytesToBase64(wavBytes);

            setMicBusy(true);
            const note = addMessage('system', __t('Recognizing…'));
            try {
                const resp = await callServer(SERVER_SCRIPT, 'transcribe', { audioBase64: b64, mimeType: 'audio/wav' });
                removeMessage(note);
                if (resp && resp.ok) {
                    const t = (resp.transcript || '').trim();
                    if (t && _inputControl && _inputControl.setText) {
                        const sep = (_voiceBaseText && !/\s$/.test(_voiceBaseText)) ? ' ' : '';
                        _inputControl.setText(_voiceBaseText + sep + t);
                    } else if (!t) {
                        addMessage('system', __t('No speech recognized.'));
                    }
                } else {
                    addMessage('system', __t('Voice input error: ') + ((resp && resp.error) || __t('unknown error')));
                }
            } catch (e) {
                removeMessage(note);
                addMessage('system', __t('Voice input error: ') + (e && e.message ? e.message : String(e)));
            } finally {
                setMicBusy(false);
                if (_inputControl && _inputControl.element) { try { _inputControl.element.focus(); } catch (_) {} }
            }
        }

        function setMicState(recording) {
            _recording = recording;
            if (_micBtn && _micBtn.element) {
                _micBtn.element.style.backgroundColor = recording ? '#f0c0c0' : '';
                _micBtn.element.title = recording ? __t('Listening… (click to stop)') : __t('Voice input');
            }
        }

        function setMicBusy(busy) {
            _busy = busy;
            if (_micBtn && _micBtn.element) {
                _micBtn.element.disabled = busy;
                if (busy) _micBtn.element.title = __t('Recognizing…');
                else if (!_recording) _micBtn.element.title = __t('Voice input');
            }
        }

        // ── WAV-утилиты ──────────────────────────────────────────────────
        function mergeChunks(chunks, total) {
            const out = new Float32Array(total);
            let off = 0;
            for (let i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
            return out;
        }

        function downsample(samples, inRate, outRate) {
            if (!inRate || inRate <= outRate) return { data: samples, rate: inRate || outRate };
            const ratio = inRate / outRate;
            const outLen = Math.floor(samples.length / ratio);
            const out = new Float32Array(outLen);
            for (let i = 0; i < outLen; i++) {
                const start = Math.floor(i * ratio);
                const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
                let sum = 0, n = 0;
                for (let j = start; j < end; j++) { sum += samples[j]; n++; }
                out[i] = n ? sum / n : 0;
            }
            return { data: out, rate: outRate };
        }

        function encodeWAV(samples, sampleRate) {
            const buffer = new ArrayBuffer(44 + samples.length * 2);
            const view = new DataView(buffer);
            function writeStr(off, s) { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
            writeStr(0, 'RIFF');
            view.setUint32(4, 36 + samples.length * 2, true);
            writeStr(8, 'WAVE');
            writeStr(12, 'fmt ');
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true);
            view.setUint16(22, 1, true);
            view.setUint32(24, sampleRate, true);
            view.setUint32(28, sampleRate * 2, true);
            view.setUint16(32, 2, true);
            view.setUint16(34, 16, true);
            writeStr(36, 'data');
            view.setUint32(40, samples.length * 2, true);
            let off = 44;
            for (let i = 0; i < samples.length; i++) {
                let s = Math.max(-1, Math.min(1, samples[i]));
                view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
                off += 2;
            }
            return new Uint8Array(buffer);
        }

        function bytesToBase64(bytes) {
            let bin = '';
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            return btoa(bin);
        }

        // ─────────────────────────────────────────────────────────────────
        // Экземпляр приложения
        // ─────────────────────────────────────────────────────────────────
        const instance = {
            appName: APP_NAME,
            form: appForm,
            async onOpen(p) {
                if (!appForm.element) { await appForm.Draw(); }
                else { try { appForm.activate(); } catch (e) {} }
            },
            onAction(action, p) { return false; },
            destroy() {
                if (_recording || _audioCtx) { setMicState(false); teardownAudio(); }
            }
        };

        appForm.instance = instance;
        await instance.onOpen(params);
        return instance;
    }
});
