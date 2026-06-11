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
        appForm.setWidth(420);
        appForm.setHeight(560);

        // Окно ассистента всегда поверх обычных окон (но ниже системных попапов ≥10000).
        const TOP_Z = 9999;
        const _origActivate = (typeof appForm.activate === 'function') ? appForm.activate.bind(appForm) : null;
        appForm.activate = function () {
            try { if (_origActivate) _origActivate(); } catch (e) {}
            try { if (this.element) { this.element.style.zIndex = String(TOP_Z); this.z = TOP_Z; } } catch (e) {}
        };

        // Прижать вплотную к правому нижнему углу (без зазоров) и держать там при ресайзе.
        // Всегда выставляет appForm.x/y (по фиксированным width/height) — это позволяет
        // вызвать её ДО первого Draw, чтобы окно сразу создалось в углу, а не мелькало
        // по центру (Form.Draw авто-центрирует только при x===0 && y===0). К самому
        // element координаты применяются, только если он уже создан.
        function positionBottomRight() {
            try {
                const w = appForm.width || (appForm.element && appForm.element.offsetWidth) || 420;
                const h = appForm.height || (appForm.element && appForm.element.offsetHeight) || 560;
                // Высота таскбара (его задаёт приложение taskbar в Form.bottomOffset) — не залезаем на него.
                const bottomOffset = (typeof Form !== 'undefined' && Form.bottomOffset) ? Form.bottomOffset : 0;
                appForm.x = Math.max(0, window.innerWidth - w);
                appForm.y = Math.max(0, window.innerHeight - h - bottomOffset);
                if (appForm.element) {
                    appForm.element.style.left = appForm.x + 'px';
                    appForm.element.style.top = appForm.y + 'px';
                }
            } catch (_) {}
        }
        window.addEventListener('resize', positionBottomRight);

        appForm.getLayoutWithData = async function () {
            return { layout: [], data: [], datasetId: null };
        };

        // ── Внутреннее состояние ─────────────────────────────────────────
        let _messagesArea = null;
        let _inputControl = null;
        let _sendBtn = null;
        let _micBtn = null;
        let _statusBar = null;             // заметный индикатор «ИИ работает»
        let _statusTimer = null;
        let _attachBtn = null;
        let _fileInput = null;
        let _attachChip = null;
        let _pendingAttachment = null;     // { name, mimeType, data(base64) }
        // Историю/буфер для модели теперь ведёт сервер (агент шлёт только новое сообщение,
        // сервер собирает контекст из БД: пересказ + факты + несвёрнутый хвост сообщений).

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
            // Задаём итоговую позицию (правый нижний угол) ДО первого показа окна,
            // иначе Form.Draw авто-центрирует пустое окно, оно мелькнёт по центру,
            // и только потом перепрыгнет в угол (строка ниже). element ещё нет —
            // positionBottomRight просто выставит appForm.x/y, которые подхватит Form.Draw.
            positionBottomRight();
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

            // Индикатор активности «ИИ работает» (виден только во время работы).
            _statusBar = document.createElement('div');
            _statusBar.style.flexShrink = '0';
            _statusBar.style.display = 'none';
            _statusBar.style.padding = '4px 8px';
            _statusBar.style.fontFamily = 'MS Sans Serif, sans-serif';
            _statusBar.style.fontSize = '11px';
            _statusBar.style.fontWeight = 'bold';
            _statusBar.style.color = '#ffffff';
            _statusBar.style.backgroundColor = '#3a6ea5';
            _statusBar.style.borderTop = '1px solid #2a5a8a';
            _statusBar.style.textAlign = 'center';
            contentArea.appendChild(_statusBar);

            // Плашка прикреплённого файла (видна, пока есть вложение).
            _attachChip = document.createElement('div');
            _attachChip.style.flexShrink = '0';
            _attachChip.style.display = 'none';
            _attachChip.style.padding = '3px 8px';
            _attachChip.style.fontFamily = 'MS Sans Serif, sans-serif';
            _attachChip.style.fontSize = '11px';
            _attachChip.style.background = '#eef3f8';
            _attachChip.style.borderTop = '1px solid #c0c8d0';
            contentArea.appendChild(_attachChip);

            // Скрытый input для выбора файла.
            _fileInput = document.createElement('input');
            _fileInput.type = 'file';
            _fileInput.accept = 'image/*,application/pdf,.txt';
            _fileInput.style.display = 'none';
            _fileInput.addEventListener('change', onFilePicked);
            contentArea.appendChild(_fileInput);

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

            // Кнопка прикрепления файла
            _attachBtn = new Button(inputRow);
            _attachBtn.setIcon('/apps/general_icons/resources/public/16x16/attach.png');
            _attachBtn.setWidth(40);
            _attachBtn.Draw(inputRow);
            if (_attachBtn.element) {
                _attachBtn.element.style.height = '100%';
                _attachBtn.element.style.flexShrink = '0';
                _attachBtn.element.style.alignSelf = 'stretch';
                _attachBtn.element.style.boxSizing = 'border-box';
                _attachBtn.element.title = __t('Attach a file (image or PDF)');
            }
            _attachBtn.onClick = function () { if (_fileInput) _fileInput.click(); };

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

            const restored = await loadConversation();
            if (!restored) {
                addMessage('system', __t('Connected to Google Gemini. Ask in words or by voice — e.g. «open a new booking and fill in the dates».'));
            }
            // вплотную в правый нижний угол + поверх всех окон
            try { positionBottomRight(); } catch (_) {}
            try { if (this.element) this.element.style.zIndex = String(TOP_Z); } catch (_) {}
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

        // Заметный индикатор: видно, что ИИ ещё работает (анимированная строка).
        function setBusy(busy) {
            if (!_statusBar) return;
            if (busy) {
                _statusBar.style.display = 'block';
                const base = __t('AI is working');
                let dots = 0;
                _statusBar.textContent = '⏳ ' + base;
                if (_statusTimer) clearInterval(_statusTimer);
                _statusTimer = setInterval(function () {
                    dots = (dots + 1) % 4;
                    _statusBar.textContent = '⏳ ' + base + '.'.repeat(dots);
                }, 400);
            } else {
                if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
                _statusBar.style.display = 'none';
            }
        }

        // ── Вложения (картинка/PDF → агент «видит» файл) ─────────────────
        function readFileAsBase64(file) {
            return new Promise(function (resolve, reject) {
                const fr = new FileReader();
                fr.onload = function () {
                    const res = String(fr.result || '');
                    const c = res.indexOf(',');
                    resolve(c >= 0 ? res.slice(c + 1) : res);   // отрезаем "data:...;base64,"
                };
                fr.onerror = reject;
                fr.readAsDataURL(file);
            });
        }

        async function onFilePicked() {
            const file = _fileInput && _fileInput.files && _fileInput.files[0];
            if (!file) return;
            try {
                const data = await readFileAsBase64(file);
                if (data.length > 25 * 1024 * 1024) {
                    addMessage('system', __t('File is too large (max ~25 MB).'));
                    clearAttachment();
                    return;
                }
                _pendingAttachment = { name: file.name || 'file', mimeType: file.type || 'application/octet-stream', data: data };
                renderChip();
            } catch (e) {
                addMessage('system', __t('Could not read the file.'));
                clearAttachment();
            }
            try { _fileInput.value = ''; } catch (_) {}   // чтобы можно было выбрать тот же файл снова
        }

        function renderChip() {
            if (!_attachChip) return;
            if (!_pendingAttachment) { _attachChip.style.display = 'none'; _attachChip.textContent = ''; return; }
            _attachChip.textContent = '📎 ' + _pendingAttachment.name + '   ';
            const x = document.createElement('span');
            x.textContent = '✕';
            x.style.cursor = 'pointer';
            x.style.color = '#a00000';
            x.style.fontWeight = 'bold';
            x.title = __t('Remove attachment');
            x.addEventListener('click', clearAttachment);
            _attachChip.appendChild(x);
            _attachChip.style.display = 'block';
        }

        function clearAttachment() {
            _pendingAttachment = null;
            if (_attachChip) { _attachChip.style.display = 'none'; _attachChip.textContent = ''; }
            try { if (_fileInput) _fileInput.value = ''; } catch (_) {}
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

            // Долговременная память (выполняется на сервере, хранится по userId).
            async remember(args) {
                const text = args && args.text;
                if (!text) return { error: 'text is required' };
                try { return await callServer(SERVER_SCRIPT, 'remember', { text: text }); }
                catch (e) { return { error: (e && e.message) || String(e) }; }
            },
            async forget(args) {
                const text = args && args.text;
                if (!text) return { error: 'text is required' };
                try { return await callServer(SERVER_SCRIPT, 'forget', { text: text }); }
                catch (e) { return { error: (e && e.message) || String(e) }; }
            },

            // Осведомлённость об открытых окнах + переключение между ними (как человек мышкой).
            list_windows() {
                try {
                    const list = (window.MySpace && typeof window.MySpace.listInstances === 'function') ? window.MySpace.listInstances() : [];
                    return { ok: true, windows: list.filter(w => w.appName !== 'ai_chat') };
                } catch (e) { return { error: (e && e.message) || String(e) }; }
            },
            focus_window(args) {
                const id = args && args.id;
                if (!id) return { error: 'id is required' };
                const inst = (window.MySpace && typeof window.MySpace.getInstance === 'function') ? window.MySpace.getInstance(id) : null;
                if (!inst) return { error: 'window not found: ' + id };
                const form = inst.form || inst;
                this._form = form;
                this._instanceId = id;
                try { if (form && typeof form.activate === 'function') form.activate(); } catch (_) {}
                return { ok: true, focused: id, table: (form && (form.dbTable || form.tableName)) || null };
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
                    const f = { name: fname, label: m.label || fname, type: m.type || 'text', value: values[fname] };
                    if (m.refTable) { f.reference = true; f.refTable = m.refTable; }
                    fields.push(f);
                }
                const buttons = collectLayoutButtons(form.layout);
                const tables = collectLayoutTables(form);
                return { ok: true, table, fields, buttons, tables };
            },

            async fill_field(args) {
                const form = this._form;
                if (!form) return { error: 'no open form' };
                const name = args.name;
                if (!name) return { error: 'name is required' };
                const ctrl = form.controlsMap && form.controlsMap[name];
                if (!ctrl) return { error: 'field not found: ' + name + ' (use read_form_state for exact names)' };

                let value = (args.value !== undefined) ? args.value : '';

                // Поле-ссылка (recordSelector): резолвим название → запись через quickSearch
                const ref = this._refInfoForField(form, name);
                if (ref) return await this._setReference(form, ctrl, name, ref.table, ref.displayField, value);

                // Адресное поле → нормализуем через Google Places (тот же механизм, что у AddressBox).
                if (this._isAddressField(form, name) && typeof window !== 'undefined' &&
                    window.MySpaceAddress && typeof window.MySpaceAddress.resolve === 'function') {
                    try {
                        const formatted = await window.MySpaceAddress.resolve(value);
                        if (formatted) value = formatted;   // подставляем нормализованный адрес
                    } catch (_) { /* Places недоступен — оставим как есть */ }
                }

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

            // Адресное ли это поле (рендерится как AddressBox).
            _isAddressField(form, name) {
                try {
                    const meta = {};
                    collectLayoutFields(form.layout, meta);
                    return !!(meta[name] && meta[name].type === 'address');
                } catch (_) { return false; }
            },

            // Инфо о поле-ссылке { table, displayField } (из живого контрола или из лейаута).
            _refInfoForField(form, name) {
                try {
                    const ctrl = form.controlsMap && form.controlsMap[name];
                    const sel = ctrl && ctrl.properties && ctrl.properties.selection;
                    if (sel && sel.table) return { table: sel.table, displayField: sel.displayField || null };
                    const meta = {};
                    collectLayoutFields(form.layout, meta);
                    const m = meta[name];
                    if (m && m.refTable) return { table: m.refTable, displayField: m.refDisplayField || null };
                    return null;
                } catch (_) { return null; }
            },

            // Резолвит название → запись (quickSearch с RLS) и проставляет UID+display.
            async _setReference(form, ctrl, name, refTable, refDisplayField, query) {
                if (query === undefined || query === null || query === '') return { error: 'empty value for reference field ' + name };
                const r = await this._lookup(refTable, refDisplayField, query);
                if (r.error) return { ok: false, error: r.error };
                if (r.ambiguous) return {
                    ok: false, ambiguous: true, candidates: r.candidates,
                    message: 'No single match in ' + refTable + '. Pick the intended record from candidates and call fill_field again with its exact name.'
                };
                try {
                    if (typeof ctrl.setValue === 'function') ctrl.setValue(r.UID, r.name);
                    else if (ctrl.element) ctrl.element.value = r.UID;
                    if (typeof form.setModified === 'function') form.setModified(true);
                } catch (e) { return { error: 'set failed: ' + (e && e.message || String(e)) }; }
                return { ok: true, name, set: { UID: r.UID, name: r.name } };
            },

            // Поиск записи по названию (RLS) с нечётким сопоставлением по токенам.
            // → {UID,name} | {ambiguous,candidates} | {error}
            async _lookup(refTable, refDisplayField, query) {
                const search = async (text, limit) => {
                    try {
                        const r = await callServerMethod('uniForm', 'quickSearch', { tableName: refTable, searchText: text, limit: limit, displayField: refDisplayField || undefined });
                        return (r && r.items) || [];
                    } catch (e) { return { __error: (e && e.message) || String(e) }; }
                };
                const q = String(query).trim().toLowerCase();

                // 1) строгий поиск по подстроке
                let items = await search(String(query), 8);
                if (items && items.__error) return { error: 'search failed: ' + items.__error };
                const exact = items.filter(it => String(it.name || '').trim().toLowerCase() === q);
                if (exact.length === 1) return { UID: exact[0].UID, name: exact[0].name };
                if (items.length === 1) return { UID: items[0].UID, name: items[0].name };

                // 2) нечёткое сопоставление по токенам на полном списке
                //    (устойчиво к сокращениям: «FeWo Nr. III» → «Ferienwohnung III» по токену «iii»)
                let all = items.length ? items : await search('', 25);
                if (all && all.__error) all = [];
                const toks = q.split(/[\s.,/]+/).filter(t => t.length > 0);
                if (all.length && toks.length) {
                    const scoreOf = (nm) => { const n = String(nm || '').toLowerCase(); return toks.reduce((s, t) => s + (n.indexOf(t) >= 0 ? 1 : 0), 0); };
                    const scored = all.map(it => ({ it: it, s: scoreOf(it.name) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
                    if (scored.length === 1) return { UID: scored[0].it.UID, name: scored[0].it.name };
                    if (scored.length > 1 && scored[0].s > scored[1].s) return { UID: scored[0].it.UID, name: scored[0].it.name };
                }

                // 3) однозначно не вышло — вернуть доступные варианты для выбора моделью
                return { ambiguous: true, candidates: all.map(it => ({ UID: it.UID, name: it.name })) };
            },

            async find_records(args) {
                const table = args.table;
                if (!table) return { error: 'table is required' };
                const query = args.query || '';
                const limit = Math.max(1, Math.min(args.limit || 8, 20));
                let res;
                try {
                    res = await callServerMethod('uniForm', 'quickSearch', { tableName: table, searchText: String(query), limit: limit });
                } catch (e) { return { error: 'search failed: ' + (e && e.message || String(e)) }; }
                return { ok: true, records: ((res && res.items) || []).map(it => ({ UID: it.UID, name: it.name })) };
            },

            // Добавить строку в табличную часть формы (комнату, гостя, услугу, доп.строку).
            async add_table_row(args) {
                const form = this._form;
                if (!form) return { error: 'no open form' };
                const table = args.table;
                if (!table) return { error: 'table is required' };

                const info = this._findTableControl(form, table);
                if (!info) return { error: 'no table section "' + table + '" in this form (see read_form_state.tables)' };
                const { tbl, dataKey, columns, controlName } = info;

                // fields: [{name,value}] → объект
                const fieldsIn = {};
                const arr = Array.isArray(args.fields) ? args.fields : [];
                for (const f of arr) { if (f && f.name !== undefined) fieldsIn[f.name] = f.value; }

                // UID новой строки (как делает «добавить строку» в самой форме)
                let uid = '';
                try { const u = await callServerMethod('drive_api', 'getNewUID', { tableName: table }); uid = u && u.uid; } catch (_) {}
                const row = {};
                if (uid) row.UID = uid;

                // колонки (ссылочные резолвим по имени)
                for (const colName in fieldsIn) {
                    const val = fieldsIn[colName];
                    const col = columns.find(c => (c.data || c.name) === colName);
                    const sel = col && col.properties && col.properties.selection;
                    if (sel && sel.table) {
                        const r = await this._lookup(sel.table, sel.displayField, String(val));
                        if (r.error) return { ok: false, error: 'column "' + colName + '": ' + r.error };
                        if (r.ambiguous) return { ok: false, ambiguous: true, column: colName, candidates: r.candidates, message: 'No single match for "' + colName + '" in ' + sel.table + '. Pick from candidates and retry with the exact name.' };
                        row[colName] = r.UID;
                        row['__' + colName + '_display'] = r.name;
                    } else if (col && (col.inputType === 'checkbox' || col.type === 'checkbox')) {
                        row[colName] = (val === true || val === 'true' || val === '1' || val === 1);
                    } else {
                        row[colName] = val;
                    }
                }

                // master-detail: привязка к строке-владельцу (напр. услуга → комната)
                const link = this._autoLinkDetail(form, controlName, row);
                if (link.error) return { ok: false, error: link.error };

                try {
                    const rows = (typeof tbl.data_getRows === 'function') ? (tbl.data_getRows(dataKey) || []) : [];
                    rows.push(row);
                    if (typeof tbl.data_updateValue === 'function') tbl.data_updateValue(dataKey, rows);
                    if (typeof tbl._invokeRenderBodyRows === 'function') tbl._invokeRenderBodyRows();
                    if (typeof form.setModified === 'function') form.setModified(true);

                    // Активируем новую строку тем же путём, что и клик человека:
                    // activateRow → onRowActivate, который во фреймворке запускает те же
                    // побочные эффекты (напр. onRoomActivated добавляет дефолтные услуги,
                    // masterFor выставляет фильтр деталей). Никакой отдельной логики для агента.
                    const newIndex = rows.length - 1;
                    try {
                        if (typeof tbl.activateRow === 'function') tbl.activateRow(newIndex);
                        else if (typeof tbl.onRowActivate === 'function') tbl.onRowActivate(newIndex);
                        // даём асинхронным обработчикам (подгрузка дефолтных услуг с сервера) завершиться
                        await new Promise(function (r) { setTimeout(r, 500); });
                    } catch (_) {}

                    return { ok: true, table, rowCount: rows.length, row: row };
                } catch (e) {
                    return { error: 'add row failed: ' + (e && e.message || String(e)) };
                }
            },

            // Контрол таблицы секции по имени таблицы → { tbl, dataKey, columns, controlName }
            _findTableControl(form, table) {
                let found = null;
                const walk = (arr) => {
                    if (!Array.isArray(arr) || found) return;
                    for (const item of arr) {
                        if (found) return;
                        if (!item || typeof item !== 'object') continue;
                        if (item.type === 'table' && (item.data === table || item.tableName === table || item.name === ('ts_' + table) || item.name === table)) {
                            found = { name: item.name, dataKey: item.data, columns: item.columns || [] };
                            return;
                        }
                        if (Array.isArray(item.layout)) walk(item.layout);
                        if (Array.isArray(item.items)) walk(item.items);
                        if (Array.isArray(item.tabs)) for (const t of item.tabs) { if (t && Array.isArray(t.layout)) walk(t.layout); if (t && Array.isArray(t.items)) walk(t.items); }
                    }
                };
                walk(form.layout);
                if (!found) return null;
                const tbl = form.controlsMap && form.controlsMap[found.name];
                if (!tbl) return null;
                return { tbl, dataKey: tbl.dataKey || found.dataKey, columns: found.columns, controlName: found.name };
            },

            // Если секция — деталь мастера (услуги/гости относятся к комнате),
            // привязывает строку к последней строке мастера через detailField.
            _autoLinkDetail(form, sectionControlName, row) {
                let master = null;
                const walk = (arr) => {
                    if (!Array.isArray(arr) || master) return;
                    for (const item of arr) {
                        if (master) return;
                        if (item && item.type === 'table' && item.properties && Array.isArray(item.properties.masterFor) && item.properties.masterFor.indexOf(sectionControlName) >= 0) {
                            master = item; return;
                        }
                        if (Array.isArray(item.layout)) walk(item.layout);
                        if (Array.isArray(item.tabs)) for (const t of item.tabs) { if (t && Array.isArray(t.layout)) walk(t.layout); }
                    }
                };
                walk(form.layout);
                if (!master) return { ok: true };
                const detailField = (master.properties && master.properties.detailField) || 'bookingRoomId';
                const masterField = (master.properties && master.properties.masterField) || 'UID';
                if (row[detailField]) return { ok: true };
                const masterCtrl = form.controlsMap && form.controlsMap[master.name];
                const masterRows = (masterCtrl && typeof masterCtrl.data_getRows === 'function') ? (masterCtrl.data_getRows(masterCtrl.dataKey) || []) : [];
                if (!masterRows.length) return { error: 'add a row to "' + (master.data || master.name) + '" first — this section links to it' };
                row[detailField] = masterRows[masterRows.length - 1][masterField];
                return { ok: true };
            },

            // Удалить строку секции по индексу (+ каскадно связанные detail-строки).
            async remove_table_row(args) {
                const form = this._form;
                if (!form) return { error: 'no open form' };
                const table = args.table;
                if (!table) return { error: 'table is required' };
                const info = this._findTableControl(form, table);
                if (!info) return { error: 'no table section "' + table + '" in this form' };
                const { tbl, dataKey, controlName } = info;

                const rows = (typeof tbl.data_getRows === 'function') ? (tbl.data_getRows(dataKey) || []) : [];
                const idx = (typeof args.index === 'number') ? args.index : parseInt(args.index, 10);
                if (isNaN(idx) || idx < 0 || idx >= rows.length) return { error: 'invalid index ' + args.index + ' (table has ' + rows.length + ' rows)' };

                const removed = rows[idx];
                rows.splice(idx, 1);
                try {
                    if (typeof tbl.data_updateValue === 'function') tbl.data_updateValue(dataKey, rows);
                    if (typeof tbl._invokeRenderBodyRows === 'function') tbl._invokeRenderBodyRows();
                    this._removeDetailsOf(form, controlName, removed);
                    if (typeof form.setModified === 'function') form.setModified(true);
                } catch (e) { return { error: 'remove failed: ' + (e && e.message || String(e)) }; }
                return { ok: true, table, removedIndex: idx, rowCount: rows.length };
            },

            // Очистить все строки секции (+ каскадно detail-строки).
            async clear_table(args) {
                const form = this._form;
                if (!form) return { error: 'no open form' };
                const table = args.table;
                if (!table) return { error: 'table is required' };
                const info = this._findTableControl(form, table);
                if (!info) return { error: 'no table section "' + table + '" in this form' };
                const { tbl, dataKey, controlName } = info;

                const prev = (typeof tbl.data_getRows === 'function') ? (tbl.data_getRows(dataKey) || []).slice() : [];
                try {
                    if (typeof tbl.data_updateValue === 'function') tbl.data_updateValue(dataKey, []);
                    if (typeof tbl._invokeRenderBodyRows === 'function') tbl._invokeRenderBodyRows();
                    for (const r of prev) this._removeDetailsOf(form, controlName, r);
                    if (typeof form.setModified === 'function') form.setModified(true);
                } catch (e) { return { error: 'clear failed: ' + (e && e.message || String(e)) }; }
                return { ok: true, table, cleared: true };
            },

            // Если секция — мастер (masterFor), удаляет detail-строки, ссылающиеся на removedRow.
            _removeDetailsOf(form, masterControlName, removedRow) {
                let masterItem = null;
                const locate = (arr) => {
                    if (!Array.isArray(arr) || masterItem) return;
                    for (const item of arr) {
                        if (masterItem) return;
                        if (item && item.type === 'table' && item.name === masterControlName) { masterItem = item; return; }
                        if (Array.isArray(item.layout)) locate(item.layout);
                        if (Array.isArray(item.tabs)) for (const t of item.tabs) { if (t && Array.isArray(t.layout)) locate(t.layout); }
                    }
                };
                locate(form.layout);
                const props = masterItem && masterItem.properties;
                if (!props || !Array.isArray(props.masterFor)) return;
                const detailField = props.detailField || 'bookingRoomId';
                const masterField = props.masterField || 'UID';
                const masterVal = removedRow && removedRow[masterField];
                if (!masterVal) return;
                for (const detailCtrlName of props.masterFor) {
                    const dtbl = form.controlsMap && form.controlsMap[detailCtrlName];
                    if (!dtbl || typeof dtbl.data_getRows !== 'function') continue;
                    const drows = dtbl.data_getRows(dtbl.dataKey) || [];
                    const filtered = drows.filter(r => r[detailField] !== masterVal);
                    if (filtered.length !== drows.length) {
                        try {
                            dtbl.data_updateValue(dtbl.dataKey, filtered);
                            if (typeof dtbl._invokeRenderBodyRows === 'function') dtbl._invokeRenderBodyRows();
                        } catch (_) {}
                    }
                }
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
                const key = item.name || item.data;
                if (key && CONTAINER_TYPES.indexOf(item.type) === -1) {
                    const m = {
                        label: resolveCaption(item.caption) || resolveCaption(item.label) || key,
                        type: item.type || 'text'
                    };
                    const sel = item.properties && item.properties.selection;
                    if (item.type === 'recordSelector' && sel && sel.table) {
                        m.refTable = sel.table;
                        m.refDisplayField = sel.displayField || 'name';
                    }
                    meta[key] = m;
                }
                // Контейнеры: во фреймворке вложенность идёт через .layout (и .tabs[].layout)
                if (Array.isArray(item.layout)) collectLayoutFields(item.layout, meta);
                if (Array.isArray(item.items)) collectLayoutFields(item.items, meta);
                if (Array.isArray(item.columns)) collectLayoutFields(item.columns, meta);
                if (Array.isArray(item.children)) collectLayoutFields(item.children, meta);
                if (Array.isArray(item.tabs)) for (const tab of item.tabs) {
                    if (tab && Array.isArray(tab.layout)) collectLayoutFields(tab.layout, meta);
                    if (tab && Array.isArray(tab.items)) collectLayoutFields(tab.items, meta);
                }
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
                    if (Array.isArray(item.layout)) walk(item.layout);
                    if (Array.isArray(item.items)) walk(item.items);
                    if (Array.isArray(item.columns)) walk(item.columns);
                    if (Array.isArray(item.tabs)) for (const tab of item.tabs) {
                        if (tab && Array.isArray(tab.layout)) walk(tab.layout);
                        if (tab && Array.isArray(tab.items)) walk(tab.items);
                    }
                }
            };
            walk(layout);
            return btns;
        }

        // Табличные части формы: [{ table, columns:[{name,label,type,reference,refTable}], rowCount }]
        function collectLayoutTables(form) {
            const out = [];
            const walk = (arr) => {
                if (!Array.isArray(arr)) return;
                for (const item of arr) {
                    if (!item || typeof item !== 'object') continue;
                    if (item.type === 'table') {
                        const t = { table: item.data || item.tableName || item.name, columns: [] };
                        for (const c of (item.columns || [])) {
                            const col = { name: c.data || c.name, label: resolveCaption(c.caption) || (c.data || c.name), type: c.inputType || c.type || 'text' };
                            const sel = c.properties && c.properties.selection;
                            if ((c.inputType === 'recordSelector' || c.type === 'recordSelector') && sel && sel.table) { col.reference = true; col.refTable = sel.table; }
                            t.columns.push(col);
                        }
                        try {
                            const tbl = form.controlsMap && form.controlsMap[item.name];
                            const rows = (tbl && typeof tbl.data_getRows === 'function') ? (tbl.data_getRows(tbl.dataKey) || []) : [];
                            t.rowCount = rows.length;
                            t.rows = rows.slice(0, 30).map((r, i) => {
                                const view = { index: i };
                                for (const c of t.columns) {
                                    const disp = r['__' + c.name + '_display'];
                                    view[c.name] = (disp !== undefined && disp !== null && disp !== '') ? disp : r[c.name];
                                }
                                return view;
                            });
                        } catch (_) { t.rowCount = 0; t.rows = []; }
                        out.push(t);
                    }
                    if (Array.isArray(item.layout)) walk(item.layout);
                    if (Array.isArray(item.items)) walk(item.items);
                    if (Array.isArray(item.tabs)) for (const tab of item.tabs) { if (tab && Array.isArray(tab.layout)) walk(tab.layout); if (tab && Array.isArray(tab.items)) walk(tab.items); }
                }
            };
            walk(form.layout);
            return out;
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
            else if (call.name === 'find_records') detail = a.table + ' ~ ' + a.query;
            else if (call.name === 'add_table_row') detail = a.table + (Array.isArray(a.fields) ? (': ' + a.fields.map(f => f.name + '=' + f.value).join(', ')) : '');
            else if (call.name === 'remove_table_row') detail = a.table + ' #' + a.index;
            else if (call.name === 'clear_table') detail = a.table;
            else if (call.name === 'remember') detail = a.text;
            else if (call.name === 'forget') detail = a.text;
            else if (call.name === 'focus_window') detail = a.id;
            addMessage('tool', '→ ' + call.name + (detail ? (': ' + detail) : ''));
        }

        async function loadConversation() {
            try {
                const resp = await callServer(SERVER_SCRIPT, 'getConversation', {});
                if (!resp || !resp.ok) return false;
                const msgs = Array.isArray(resp.messages) ? resp.messages : [];
                for (const m of msgs) {
                    if (m && (m.role === 'user' || m.role === 'ai')) addMessage(m.role, m.text || '');
                }
                if (msgs.length) { addMessage('system', __t('— earlier conversation restored —')); return true; }
                return false;
            } catch (_) { return false; }
        }

        async function runAgent(userText, attachment) {
            const pending = addMessage('ai', '…');
            setInputEnabled(false);
            setBusy(true);

            // Сервер сам соберёт контекст из БД на первом шаге (history === null).
            let step = { userMessage: userText };
            if (attachment && attachment.data) step.attachment = { mimeType: attachment.mimeType, data: attachment.data };
            let history = null;
            let guard = 0;

            try {
                while (true) {
                    if (++guard > MAX_AGENT_STEPS) {
                        pending.textSpan.textContent = __t('⚠ Too many steps, stopping.');
                        break;
                    }
                    const payload = (history === null) ? step : Object.assign({ history: history }, step);
                    const resp = await callServer(SERVER_SCRIPT, 'agentStep', payload);
                    if (!resp || !resp.ok) {
                        pending.div.style.color = '#a00000';
                        pending.textSpan.textContent = __t('Error: ') + ((resp && resp.error) || __t('unknown error'));
                        break;
                    }
                    history = resp.history || history || [];

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
                setBusy(false);
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
            const attachment = _pendingAttachment;
            if (!text && !attachment) return;

            const displayText = attachment ? ((text ? text + '  ' : '') + '📎 ' + attachment.name) : text;
            const userMessage = text || ('📎 ' + attachment.name);

            _inputControl.setText('');
            clearAttachment();
            addMessage('user', displayText);
            await runAgent(userMessage, attachment);
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
                if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
                try { window.removeEventListener('resize', positionBottomRight); } catch (_) {}
            }
        };

        appForm.instance = instance;
        await instance.onOpen(params);
        return instance;
    }
});
