// Приложение «Редактор формул» (formula_editor).
//
// Открывается через MySpace.open('formula_editor', { formula, onApply }).
//   formula  — текущая формула (строка)
//   onApply  — колбэк(newFormula), вызывается при нажатии OK
//
// Окно: поле формулы (textarea) + легенда доступных переменных (идентификатор —
// «ссылка» голубого цвета на span, не краснеет при нажатии; клик вставляет токен
// в позицию курсора, либо в конец, если поле не в фокусе) + кнопки OK/Отмена.
//
// ВАЖНО: класс окна объявляется ЛЕНИВО, внутри createInstance, а не на верхнем
// уровне файла. Иначе `class ... extends ModalForm` вычисляется в момент загрузки
// бандла приложений, когда ModalForm может быть недоступен в области видимости
// бандла → ReferenceError ломает регистрацию приложения. В рантайме (внутри
// createInstance) классы фреймворка доступны — как `new Button()` у других приложений.

let _FormulaEditorFormClass = null;

function _buildFormulaEditorClass() {
    if (_FormulaEditorFormClass) return _FormulaEditorFormClass;

    _FormulaEditorFormClass = class FormulaEditorForm extends ModalForm {
        constructor(params) {
            super(__t('formula_editor_title'), 480, 460);
            this._formula = (params && params.formula != null) ? String(params.formula) : '';
            this._onApply = params && params.onApply;
            this._ta = null;
            this._legend = null;
        }

        Draw(container) {
            super.Draw(container);
            const W = this.width;
            const H = this.height;
            const ca = this.contentArea;

            // Поле формулы (textarea — для надёжной работы с позицией курсора).
            const ta = document.createElement('textarea');
            ta.value = this._formula;
            ta.spellcheck = false;
            ta.style.position = 'absolute';
            ta.style.left = '10px';
            ta.style.top = '10px';
            ta.style.width = (W - 32) + 'px';
            ta.style.height = '84px';
            ta.style.boxSizing = 'border-box';
            ta.style.fontFamily = 'Consolas, "Courier New", monospace';
            ta.style.fontSize = '13px';
            ta.style.resize = 'none';
            ca.appendChild(ta);
            this._ta = ta;

            // Легенда переменных.
            const legend = document.createElement('div');
            legend.style.position = 'absolute';
            legend.style.left = '10px';
            legend.style.top = '104px';
            legend.style.width = (W - 32) + 'px';
            legend.style.height = (H - 104 - 56) + 'px';
            legend.style.boxSizing = 'border-box';
            legend.style.overflow = 'auto';
            legend.style.border = '1px solid #c0c0c0';
            legend.style.background = '#ffffff';
            legend.style.padding = '6px';
            legend.style.fontFamily = 'MS Sans Serif, sans-serif';
            legend.style.fontSize = '12px';
            ca.appendChild(legend);

            const legendTitle = document.createElement('div');
            legendTitle.textContent = __t('formula_vars_legend');
            legendTitle.style.fontWeight = 'bold';
            legendTitle.style.marginBottom = '6px';
            legend.appendChild(legendTitle);
            this._legend = legend;

            // Кнопки OK / Отмена.
            const btnOk = new Button(ca);
            btnOk.setCaption(__t('OK'));
            btnOk.Draw(ca);
            btnOk.onClick = () => {
                try { if (typeof this._onApply === 'function') this._onApply(this._ta ? this._ta.value : ''); } catch (e) {}
                this.close();
            };

            const btnCancel = new Button(ca);
            btnCancel.setCaption(__t('Cancel'));
            btnCancel.Draw(ca);
            btnCancel.onClick = () => { this.close(); };

            const bw = 90, bh = 28, sp = 12;
            const totalW = bw * 2 + sp;
            const sx = (W - totalW) / 2;
            const by = H - bh - 18;
            UIObject.styleElement(btnOk, sx, by, bw, bh, 12);
            UIObject.styleElement(btnCancel, sx + bw + sp, by, bw, bh, 12);

            this._loadVariables();
            setTimeout(() => { try { ta.focus(); } catch (e) {} }, 30);
        }

        async _loadVariables() {
            let res = null;
            try {
                res = await callServer('formula_editor.actions', 'getFormulaVariables', {});
            } catch (e) {}
            const vars = (res && res.variables) || [];
            const funcs = (res && res.functions) || [];
            const operatorsHelp = res && res.operatorsHelp;

            // Переменные (вставляется сам токен @name).
            for (const v of vars) this._legend.appendChild(this._buildLegendRow(v.token, v.description, v.token));

            // Функции (вставляется открывающая скобка, напр. 'if(').
            if (funcs.length) {
                this._legend.appendChild(this._buildLegendSubtitle(__t('formula_funcs_legend')));
                for (const f of funcs) this._legend.appendChild(this._buildLegendRow(f.token, f.description, f.insert || f.token));
            }

            // Подсказка по операторам (не кликабельна).
            if (operatorsHelp) {
                const help = document.createElement('div');
                help.style.marginTop = '8px';
                help.style.lineHeight = '1.5';
                help.style.color = '#444';
                help.textContent = operatorsHelp;
                this._legend.appendChild(help);
            }
        }

        _buildLegendSubtitle(text) {
            const t = document.createElement('div');
            t.textContent = text;
            t.style.fontWeight = 'bold';
            t.style.margin = '8px 0 4px';
            return t;
        }

        // Строка легенды: кликабельный токен (вставляет insertText) + описание.
        _buildLegendRow(label, description, insertText) {
            const row = document.createElement('div');
            row.style.margin = '3px 0';
            row.style.lineHeight = '1.5';

            const link = document.createElement('span');
            link.textContent = label;
            link.style.color = '#0000CC';
            link.style.textDecoration = 'underline';
            link.style.cursor = 'pointer';
            link.style.fontFamily = 'Consolas, "Courier New", monospace';
            link.addEventListener('mousedown', (e) => { e.preventDefault(); });
            link.addEventListener('click', (e) => { e.preventDefault(); this._insertToken(insertText); });

            const desc = document.createElement('span');
            desc.textContent = ' — ' + (description || '');

            row.appendChild(link);
            row.appendChild(desc);
            return row;
        }

        _insertToken(token) {
            const ta = this._ta;
            if (!ta) return;
            const focused = (document.activeElement === ta);
            if (focused && typeof ta.selectionStart === 'number') {
                const s = ta.selectionStart, e = ta.selectionEnd, val = ta.value;
                ta.value = val.slice(0, s) + token + val.slice(e);
                const p = s + token.length;
                try { ta.setSelectionRange(p, p); } catch (_) {}
            } else {
                ta.value = ta.value + token;
            }
            try { ta.focus(); } catch (_) {}
        }
    };

    return _FormulaEditorFormClass;
}

MySpace.register('formula_editor', {
    init: function () {},
    createInstance: async function (params) {
        const p = params || {};
        const Cls = _buildFormulaEditorClass();
        const form = new Cls(p);
        form.Draw(document.body);
        const id = p.id || ('formula_editor-' + Date.now());
        return {
            id: id,
            appName: 'formula_editor',
            form: form,
            onOpen: function () {},
            onAction: function () {},
            destroy: function () { try { form.close(); } catch (e) {} }
        };
    }
});
