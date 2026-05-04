/**
 * ai_chat — Чат с локальным ИИ Chrome (Gemini Nano).
 * Использует window.ai.languageModel (Prompt API, встроен в Chrome 127+).
 * Все вычисления выполняются на стороне клиента без серверных вызовов.
 *
 * Паттерн: MySpace.register + createInstance (стандарт MySpace).
 * UI-компоненты: DataForm, MultilineTextBox, Button (из UI_classes.js).
 */

MySpace.register('ai_chat', {
    config: { allowMultipleInstances: false },

    createInstance: async function (params) {
        const APP_NAME = 'ai_chat';

        // ── DataForm — стандартный контейнер формы ──────────────────────
        const appForm = new DataForm(APP_NAME);
        appForm.setTitle(__t('Chat with AI (Chrome Gemini Nano)'));
        appForm.setWidth(560);
        appForm.setHeight(620);
        appForm.setAnchorToWindow('center');

        // Нет серверного лейаута — возвращаем пустую структуру,
        // чтобы DataForm.loadLayout() не делал RPC-запросов.
        appForm.getLayoutWithData = async function () {
            return { layout: [], data: [], datasetId: null };
        };

        // ── Внутреннее состояние ─────────────────────────────────────────
        let aiSession = null;
        let _messagesArea = null;
        let _inputControl = null;
        let _sendBtn = null;

        // ── Переопределяем Draw: вызываем стандартный Draw (создаёт окно),
        //    затем строим UI чата поверх пустого contentArea ────────────────
        const _originalDraw = appForm.Draw.bind(appForm);

        appForm.Draw = async function (parent) {
            // Стандартный DataForm.Draw: создаёт окно, грузит пустой лейаут
            await _originalDraw(parent);

            const contentArea = this.getContentArea();
            if (!contentArea) return;

            // DataForm уже установил flex-column + padding.
            // Добавляем gap между областью сообщений и строкой ввода.
            contentArea.style.gap = '6px';
            contentArea.style.padding = '8px';

            // ── Область сообщений ────────────────────────────────────────
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

            // ── Строка ввода ─────────────────────────────────────────────
            const inputRow = document.createElement('div');
            inputRow.style.display = 'flex';
            inputRow.style.flexShrink = '0';
            inputRow.style.height = '68px';
            inputRow.style.gap = '6px';
            contentArea.appendChild(inputRow);

            // MultilineTextBox — поле ввода пользователя
            _inputControl = new MultilineTextBox(inputRow);
            _inputControl.setPlaceholder(__t('Enter message... (Ctrl+Enter — send)'));
            _inputControl.Draw(inputRow);

            if (_inputControl.element) {
                // В flex-строке textarea должна занимать доступную ширину
                _inputControl.element.style.flex = '1 1 auto';
                _inputControl.element.style.width = 'auto';
                _inputControl.element.style.height = '100%';
                _inputControl.element.style.resize = 'none';
                _inputControl.element.style.boxSizing = 'border-box';

                // Ctrl+Enter — быстрая отправка без мыши
                _inputControl.element.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter' && e.ctrlKey) {
                        e.preventDefault();
                        sendMessage();
                    }
                });
            }

            // Button — кнопка «Отправить»
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

            // Инициализация AI после построения UI
            initAI();
        };

        // ─────────────────────────────────────────────────────────────────
        // Вспомогательные функции
        // ─────────────────────────────────────────────────────────────────

        /**
         * Добавляет пузырь сообщения в область истории.
         * @param {'user'|'ai'|'system'} role
         * @param {string} text
         * @returns {{div: HTMLElement, textSpan: HTMLElement}|null}
         */
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
                div.style.textAlign = 'left';
            } else if (role === 'ai') {
                div.style.backgroundColor = '#f0f0f0';
                div.style.borderLeft = '3px solid #8a8a8a';
                div.style.textAlign = 'left';
            } else {
                // системное (info/error)
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
            if (Array.isArray(text)) {
                for (const part of text) {
                    if (typeof part === 'string') {
                        textSpan.appendChild(document.createTextNode(part));
                    } else if (part && typeof part === 'object') {
                        textSpan.appendChild(part);
                    }
                }
            } else {
                textSpan.textContent = text;
            }
            div.appendChild(textSpan);

            _messagesArea.appendChild(div);
            _messagesArea.scrollTop = _messagesArea.scrollHeight;

            return { div, textSpan };
        }

        /**
         * Создаёт span-«ссылку» на chrome:// адрес.
         * Клик копирует URL в буфер обмена и показывает подтверждение.
         * (Браузер блокирует прямой переход на chrome:// из веб-страниц,
         *  поэтому копирование — единственный надёжный способ.)
         */
        function chromeFlagLink(url) {
            const span = document.createElement('span');
            span.textContent = url;
            span.style.color = '#0055cc';
            span.style.textDecoration = 'underline';
            span.style.cursor = 'pointer';
            span.style.fontFamily = 'monospace';
            span.style.fontStyle = 'normal';
            span.title = __t('Click to copy address');
            span.addEventListener('click', function () {
                try {
                    navigator.clipboard.writeText(url).then(function () {
                        span.textContent = __t('✓ copied');
                        span.style.color = '#007700';
                        setTimeout(function () {
                            span.textContent = url;
                            span.style.color = '#0055cc';
                        }, 1500);
                    }).catch(function () {});
                } catch (e) {}
            });
            return span;
        }

        /**
         * Блокирует / разблокирует кнопку отправки и поле ввода.
         */
        function setInputEnabled(enabled) {
            if (_sendBtn && _sendBtn.element) _sendBtn.element.disabled = !enabled;
            if (_inputControl && _inputControl.element) _inputControl.element.disabled = !enabled;
        }

        /**
         * Инициализирует сессию Chrome Gemini Nano.
         * Поддерживает оба поколения API:
         *   • Chrome 127-137: window.ai.languageModel  (старый)
         *   • Chrome 138+:    window.LanguageModel      (новый стандарт)
         */
        async function initAI() {
            setInputEnabled(false);

            try {
                // ── Проверка браузера ────────────────────────────────────
                const ua = navigator.userAgent || '';
                const chromeMatch = ua.match(/Chrome\/(\d+)/);
                const chromeMajor = chromeMatch ? parseInt(chromeMatch[1], 10) : null;

                if (!chromeMajor) {
                    addMessage('system',
                        __t('✗ Unsupported browser.\nGoogle Chrome is required.'));
                    return;
                }

                addMessage('system', __t('● Browser: Google Chrome ') + chromeMajor);

                if (chromeMajor < 127) {
                    addMessage('system', [
                        __t('✗ Chrome version is too old (') + chromeMajor + __t(', required: 127+).\nUpdate: '), chromeFlagLink('chrome://settings/help')
                    ]);
                    return;
                }

                // ── Определяем версию API ────────────────────────────────
                // Chrome 138+ переименовал API: window.ai.languageModel → window.LanguageModel
                let apiObj = null;   // объект с методами create() и capabilities()/availability()
                let apiGen = 0;      // 1 = старый (window.ai.languageModel), 2 = новый (window.LanguageModel)

                if (window.LanguageModel) {
                    apiObj = window.LanguageModel;
                    apiGen = 2;
                    addMessage('system', '● API: window.LanguageModel (Chrome 138+)');
                } else if (window.ai && window.ai.languageModel) {
                    apiObj = window.ai.languageModel;
                    apiGen = 1;
                    addMessage('system', '● API: window.ai.languageModel (Chrome 127–137)');
                } else {
                    // Ни один API не найден — разбираемся почему
                    if (!window.ai && !window.LanguageModel) {
                        addMessage('system', [
                            __t('✗ Prompt API not found (window.ai and window.LanguageModel are absent).\n\nStep 1 — enable the optimization flag:\n  '),
                            chromeFlagLink('chrome://flags/#optimization-guide-on-device-model'),
                            __t(' → Enabled BypassPerfRequirement\n\nStep 2 — enable Prompt API:\n  '),
                            chromeFlagLink('chrome://flags/#prompt-api-for-gemini-nano'),
                            __t(' → Enabled\n\nStep 3 — restart Chrome and reopen the app.')
                        ]);
                    } else if (window.ai && !window.ai.languageModel) {
                        addMessage('system', [
                            __t('✗ window.ai found, but window.ai.languageModel is absent.\nEnable flag: '), chromeFlagLink('chrome://flags/#prompt-api-for-gemini-nano'),
                            __t(' → Enabled\nThen restart Chrome.')
                        ]);
                    } else {
                        addMessage('system', __t('✗ Prompt API not detected. Restart Chrome after enabling the flags.'));
                    }
                    return;
                }

                addMessage('system', __t('● Prompt API detected. Checking model availability...'));

                // ── Получаем статус модели ───────────────────────────────
                // Старый API: .capabilities() → { available: "readily"|"after-download"|"no" }
                // Новый API:  .availability() → "available"|"downloadable"|"downloading"|"unavailable"
                let statusRaw = '';
                try {
                    if (apiGen === 2) {
                        statusRaw = await apiObj.availability();
                    } else {
                        const caps = await apiObj.capabilities();
                        // Нормализуем в новый формат для единой проверки ниже
                        statusRaw = caps.available === 'readily'       ? 'available'    :
                                    caps.available === 'after-download' ? 'downloadable' :
                                    caps.available === 'no'             ? 'unavailable'  :
                                    (caps.available || 'unavailable');
                    }
                } catch (e) {
                    addMessage('system', '✗ ' + __t('Availability check error: ') + (e && e.message ? e.message : String(e)));
                    return;
                }

                addMessage('system', __t('● Model status: ') + statusRaw);

                if (statusRaw === 'unavailable') {
                    addMessage('system', [
                        __t('✗ Gemini Nano model is unavailable.\nOpen '), chromeFlagLink('chrome://components'),
                        __t(' → find "Optimization Guide On Device Model"\n→ click «Check for updates» and wait for download.\nThen restart Chrome and reopen the app.')
                    ]);
                    return;
                }

                // ── Ожидание скачивания / создание сессии ───────────────
                let progressResult = null;
                let _dlTimer = null;
                let _dlStart = null;
                let _dlHadProgress = false;

                const needsDownload = (statusRaw === 'downloadable' || statusRaw === 'downloading' || statusRaw === 'after-download');
                if (needsDownload) {
                    addMessage('system', __t('⬇ Gemini Nano model (~1.5–2 GB) is not yet downloaded.'));
                    addMessage('system', [
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n',
                        __t('📌 Step 1: make sure the flag is set correctly:\n  '),
                        chromeFlagLink('chrome://flags/#optimization-guide-on-device-model'),
                        __t('\n  → value: Enabled BypassPerfRequirement\n  (not just Enabled — specifically BypassPerfRequirement)\n\n'),
                        __t('📌 Step 2: start the download manually:\n  '),
                        chromeFlagLink('chrome://components'),
                        __t('\n  → find «Optimization Guide On Device Model»\n'),
                        __t('  → click «Check for updates»\n'),
                        __t('  → if status stays at 0.0.0.0 and «No update required» —\n'),
                        __t('    click the button again after 30–60 sec (Chrome sometimes does not respond immediately)\n\n'),
                        __t('📌 Step 3: if the button does not help — open DevTools (F12) on\n'),
                        __t('  any tab and run in console:\n'),
                        '    await LanguageModel.create()\n',
                        __t('  This will force the download.\n\n'),
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n',
                        __t('The app will activate automatically after download.')
                    ]);

                    progressResult = addMessage('system', __t('  ⏳ Waiting: 0 sec'));
                    _dlStart = Date.now();

                    // Таймер: показывает сколько ждём
                    _dlTimer = setInterval(function () {
                        try {
                            if (!progressResult || _dlHadProgress) return;
                            const elapsed = Math.round((Date.now() - _dlStart) / 1000);
                            const min = Math.floor(elapsed / 60);
                            const sec = elapsed % 60;
                            const timeStr = min > 0 ? min + __t(' min ') + sec + __t(' sec') : sec + __t(' sec');
                            progressResult.textSpan.textContent = __t('  ⏳ Waiting: ') + timeStr;
                            if (_messagesArea) _messagesArea.scrollTop = _messagesArea.scrollHeight;
                        } catch (_) {}
                    }, 1000);

                    // Цикл опроса: пробуем создать сессию каждые 5 сек.
                    // create() одновременно триггерит загрузку И возвращает сессию когда готово.
                    const pollCreate = async function () {
                        while (true) {
                            try {
                                aiSession = await apiObj.create({
                                    monitor(m) {
                                        m.addEventListener('downloadprogress', function (e) {
                                            try {
                                                if (!progressResult) return;
                                                const loaded = e.loaded || 0;
                                                const total = e.total || 0;
                                                if (loaded === 0 && total === 0) return;

                                                if (!_dlHadProgress) {
                                                    _dlHadProgress = true;
                                                    if (_dlTimer) { clearInterval(_dlTimer); _dlTimer = null; }
                                                }

                                                let line;
                                                if (total > 0) {
                                                    const pct = Math.round((loaded / total) * 100);
                                                    const mb = (loaded / 1048576).toFixed(1);
                                                    const totalMb = (total / 1048576).toFixed(1);
                                                    const filled = Math.floor(pct / 5);
                                                    const bar = '[' + '█'.repeat(filled) + '░'.repeat(20 - filled) + ']';
                                                    line = '  ' + bar + ' ' + pct + '%  (' + mb + ' / ' + totalMb + ' MB)';
                                                } else {
                                                    const mb = (loaded / 1048576).toFixed(1);
                                                    line = __t('  Downloaded: ') + mb + ' MB...';
                                                }
                                                progressResult.textSpan.textContent = line;
                                                if (_messagesArea) _messagesArea.scrollTop = _messagesArea.scrollHeight;
                                            } catch (_) {}
                                        });
                                    }
                                });
                                // create() вернул сессию — загрузка завершена
                                break;
                            } catch (e) {
                                // Ещё не готово — ждём 5 сек и пробуем снова
                                await new Promise(function (r) { setTimeout(r, 5000); });
                            }
                        }
                    };
                    await pollCreate();

                    if (_dlTimer) { clearInterval(_dlTimer); _dlTimer = null; }
                    if (progressResult) {
                        const elapsed = _dlStart ? Math.round((Date.now() - _dlStart) / 1000) : 0;
                        const min = Math.floor(elapsed / 60);
                        const sec = elapsed % 60;
                        const timeStr = min > 0 ? min + __t(' min ') + sec + __t(' sec') : sec + __t(' sec');
                        progressResult.textSpan.textContent = _dlHadProgress
                            ? __t('  [████████████████████] 100%  — download complete.')
                            : __t('  ✓ Download complete (waited: ') + timeStr + ')';
                        if (_messagesArea) _messagesArea.scrollTop = _messagesArea.scrollHeight;
                    }
                } else {
                    // Модель уже доступна — просто создаём сессию
                    aiSession = await apiObj.create();
                }

                addMessage('system', __t('✓ Gemini Nano ready. Enter a message and click «Send» (or Ctrl+Enter).'));
                setInputEnabled(true);
                if (_inputControl && _inputControl.element) {
                    try { _inputControl.element.focus(); } catch (_) {}
                }

            } catch (e) {
                addMessage('system', '✗ ' + __t('Initialization error: ') + (e && e.message ? e.message : String(e)));
            }
        }

        /**
         * Читает текст из поля ввода, отправляет запрос в AI,
         * стримит ответ в новый пузырь сообщения.
         */
        async function sendMessage() {
            if (!_inputControl || !_inputControl.getText) return;

            const rawText = _inputControl.getText();
            const text = rawText ? rawText.trim() : '';
            if (!text) return;
            if (!aiSession) return; // сессия ещё не создана (кнопка должна быть заблокирована)

            // Очищаем поле ввода и фиксируем сообщение пользователя
            _inputControl.setText('');
            addMessage('user', text);

            // Резервируем пузырь для ответа AI
            const result = addMessage('ai', '...');
            if (!result) return;
            const { textSpan } = result;
            textSpan.textContent = '';

            // Блокируем отправку на время streming
            if (_sendBtn && _sendBtn.element) _sendBtn.element.disabled = true;

            try {
                // promptStreaming возвращает AsyncIterable<string>,
                // каждый chunk — кумулятивный текст ответа (не дельта).
                const stream = await aiSession.promptStreaming(text);
                for await (const chunk of stream) {
                    textSpan.textContent = chunk;
                    if (_messagesArea) _messagesArea.scrollTop = _messagesArea.scrollHeight;
                }
            } catch (e) {
                textSpan.textContent = __t('Error: ') + (e && e.message ? e.message : String(e));
            } finally {
                if (_sendBtn && _sendBtn.element) _sendBtn.element.disabled = false;
                if (_inputControl && _inputControl.element) {
                    try { _inputControl.element.focus(); } catch (_) {}
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // Экземпляр приложения
        // ─────────────────────────────────────────────────────────────────
        const instance = {
            appName: APP_NAME,
            form: appForm,

            async onOpen(p) {
                // Draw идемпотентен: повторный вызов (reuse single-instance)
                // просто выведет форму на передний план через activate().
                if (!appForm.element) {
                    await appForm.Draw();
                } else {
                    try { appForm.activate(); } catch (e) {}
                }
            },

            onAction(action, p) {
                // Нет кастомных действий; возвращаем false,
                // чтобы фреймворк продолжил стандартную цепочку.
                return false;
            },

            destroy() {
                if (aiSession) {
                    try { aiSession.destroy(); } catch (e) {}
                    aiSession = null;
                }
            }
        };

        appForm.instance = instance;

        // Слушаем закрытие формы для освобождения AI-сессии
        const formSelf = appForm;
        function onFormDestroyed(e) {
            if (e && e.detail && e.detail.form === formSelf) {
                window.removeEventListener('form-destroyed', onFormDestroyed);
                if (aiSession) {
                    try { aiSession.destroy(); } catch (e) {}
                    aiSession = null;
                }
            }
        }
        window.addEventListener('form-destroyed', onFormDestroyed);

        await instance.onOpen(params);
        return instance;
    }
});
