/**
 * ai_chat — Чат с внешней моделью Google Gemini.
 * Вся логика AI выполняется на сервере (apps/ai_chat/forms/chat.server.js),
 * который проксирует запросы в Gemini API. Клиент только рисует UI и шлёт
 * сообщения через callServer('ai_chat.gemini', 'sendMessage', ...).
 *
 * Паттерн: MySpace.register + createInstance.
 * UI-компоненты: DataForm, MultilineTextBox, Button (из UI_classes.js).
 */

MySpace.register('ai_chat', {
    config: { allowMultipleInstances: false },

    createInstance: async function (params) {
        const APP_NAME = 'ai_chat';
        const SERVER_SCRIPT = 'ai_chat.gemini';

        // ── DataForm — стандартный контейнер формы ──────────────────────
        const appForm = new DataForm(APP_NAME);
        appForm.setTitle(__t('AI Assistant'));
        appForm.setWidth(560);
        appForm.setHeight(620);
        appForm.setAnchorToWindow('center');

        // Нет серверного лейаута — возвращаем пустую структуру.
        appForm.getLayoutWithData = async function () {
            return { layout: [], data: [], datasetId: null };
        };

        // ── Внутреннее состояние ─────────────────────────────────────────
        let _messagesArea = null;
        let _inputControl = null;
        let _sendBtn = null;
        // История диалога для контекста: [{ role: 'user'|'ai', text }]
        const conversationHistory = [];

        // ── Draw: стандартное окно + UI чата поверх contentArea ──────────
        const _originalDraw = appForm.Draw.bind(appForm);

        appForm.Draw = async function (parent) {
            await _originalDraw(parent);

            const contentArea = this.getContentArea();
            if (!contentArea) return;

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
                    if (e.key === 'Enter' && e.ctrlKey) {
                        e.preventDefault();
                        sendMessage();
                    }
                });
            }

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

            addMessage('system', __t('Connected to Google Gemini. Enter a message and click «Send» (or Ctrl+Enter).'));
            if (_inputControl && _inputControl.element) {
                try { _inputControl.element.focus(); } catch (_) {}
            }
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
            } else if (role === 'ai') {
                div.style.backgroundColor = '#f0f0f0';
                div.style.borderLeft = '3px solid #8a8a8a';
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

        function setInputEnabled(enabled) {
            if (_sendBtn && _sendBtn.element) _sendBtn.element.disabled = !enabled;
            if (_inputControl && _inputControl.element) _inputControl.element.disabled = !enabled;
        }

        /**
         * Читает текст из поля, шлёт его на сервер (→ Gemini), показывает ответ.
         */
        async function sendMessage() {
            if (!_inputControl || !_inputControl.getText) return;

            const rawText = _inputControl.getText();
            const text = rawText ? rawText.trim() : '';
            if (!text) return;

            _inputControl.setText('');
            addMessage('user', text);

            // Контекст = вся история ДО текущего сообщения.
            const historyToSend = conversationHistory.slice();
            conversationHistory.push({ role: 'user', text: text });

            const pending = addMessage('ai', '…');
            if (!pending) return;

            setInputEnabled(false);
            try {
                const resp = await callServer(SERVER_SCRIPT, 'sendMessage', {
                    message: text,
                    history: historyToSend
                });

                if (resp && resp.ok) {
                    pending.textSpan.textContent = resp.reply;
                    conversationHistory.push({ role: 'ai', text: resp.reply });
                } else {
                    const err = (resp && resp.error) ? resp.error : __t('unknown error');
                    pending.div.style.color = '#a00000';
                    pending.textSpan.textContent = __t('Error: ') + err;
                }
            } catch (e) {
                pending.div.style.color = '#a00000';
                pending.textSpan.textContent = __t('Error: ') + (e && e.message ? e.message : String(e));
            } finally {
                setInputEnabled(true);
                if (_messagesArea) _messagesArea.scrollTop = _messagesArea.scrollHeight;
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
                if (!appForm.element) {
                    await appForm.Draw();
                } else {
                    try { appForm.activate(); } catch (e) {}
                }
            },

            onAction(action, p) {
                return false;
            },

            destroy() {}
        };

        appForm.instance = instance;

        await instance.onOpen(params);
        return instance;
    }
});
