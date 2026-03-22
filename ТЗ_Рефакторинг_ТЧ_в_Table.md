# ТЗ: Перенос логики Табличных частей в класс Table

## Контекст

Сейчас добавление/удаление строк ТЧ обрабатывается в `DataForm.doAction` через перехват
`recordAdd` / `recordDelete` с проверкой `params.dataKey` на признак ТЧ в `_dataMap`.

Это архитектурно неверно — `DataForm` знает о внутренней структуре ТЧ, хотя вся логика
принадлежит самой таблице.

## Цель

Перенести логику inline-редактирования строк ТЧ из `DataForm.doAction` в класс `Table`,
чтобы `DataForm` не имел никакого представления о ТЧ.

## Файл

`node_modules/my-old-space/drive_forms/resources/public/UI_classes.js`

---

## Что нужно сделать

### 1. Добавить в `Table` признак ТЧ

В конструкторе `Table` (класс, строка ~6110):

```javascript
// Признак табличной части — выставляется автоматически через _dataMap
this.isTabularSection = false; // будет выставлен в Draw если dataKey указывает на ТЧ
```

В начале `Table.Draw()`, после того как `this.appForm._dataMap` доступен:

```javascript
// Автоматически определяем: является ли эта таблица табличной частью
try {
    if (this.dataKey && this.appForm && this.appForm._dataMap) {
        const entry = this.appForm._dataMap[this.dataKey];
        this.isTabularSection = !!(entry && entry.tabularSection === true);
    }
} catch (e) {}
```

### 2. Обработать `recordAdd` / `recordDelete` внутри `Table`

В `Table.Draw()`, при создании кнопок тулбара — вместо передачи action на `appForm`,
перехватывать в самой таблице. Добавить метод в класс `Table`:

```javascript
doToolbarAction(action) {
    if (action === 'recordAdd' && this.isTabularSection) {
        const rows = this.data_getRows(this.dataKey);
        const newRow = {};
        if (Array.isArray(this.columns)) {
            for (const col of this.columns) { if (col.data) newRow[col.data] = ''; }
        }
        rows.push(newRow);
        this.data_updateValue(this.dataKey, rows);
        try { this._invokeRenderBodyRows && this._invokeRenderBodyRows(); } catch (_) {}
        try { if (this.appForm && typeof this.appForm.setModified === 'function') this.appForm.setModified(true); } catch (_) {}
        return true; // обработано
    }
    if (action === 'recordDelete' && this.isTabularSection) {
        const activeIdx = this._activeRowIndex;
        if (activeIdx < 0) return true;
        const rows = this.data_getRows(this.dataKey);
        if (Array.isArray(rows) && activeIdx < rows.length) {
            rows.splice(activeIdx, 1);
            this._activeRowIndex = -1;
            this.data_updateValue(this.dataKey, rows);
            try { this._invokeRenderBodyRows && this._invokeRenderBodyRows(); } catch (_) {}
            try { if (this.appForm && typeof this.appForm.setModified === 'function') this.appForm.setModified(true); } catch (_) {}
        }
        return true; // обработано
    }
    return false; // не обработано — передать в appForm
}
```

В тулбаре таблицы (при создании кнопок в `Draw`) вместо:
```javascript
btn.onClick = () => this.appForm.doAction(action, params);
```
сделать:
```javascript
btn.onClick = () => {
    if (!this.doToolbarAction(action)) {
        this.appForm && this.appForm.doAction(action, params);
    }
};
```

> **Замечание**: сейчас кнопки тулбара создаются через `appForm.renderItem(toolbarLayout, ...)`,
> и onClick делегируется через `DataForm.doAction`. Чтобы Table обрабатывал сам —
> надо либо строить кнопки напрямую (DOM), либо сохранить ссылку на таблицу при
> создании кнопок через `renderItem` и передать её в `params`.
> Рекомендуется строить тулбар напрямую DOM-методами (не через renderItem),
> чтобы избавиться от цепочки `appForm.doAction → DataForm.doAction`.

### 3. Убрать из `DataForm.doAction` блоки recordAdd/recordDelete для ТЧ

После реализации п.2 — удалить из `DataForm.doAction` (строки ~2321-2359) блоки:
```javascript
if (action === 'recordAdd') { /* TS-логику */ }
if (action === 'recordDelete') { /* TS-логику */ }
```

Они больше не нужны — таблица обрабатывает сама.

### 4. Убрать `dataKey` из params кнопок тулбара

Когда таблица сама обрабатывает действия — `dataKey` в `params` передавать не нужно.
Вернуть кнопки к `params: { isStandard: true }`.

---

## Результат

- `DataForm` ничего не знает о ТЧ — только собирает данные при сохранении
- `Table` сам решает: обработать действие inline (если ТЧ) или передать в appForm
- Архитектура соответствует принципу «контрол отвечает за своё поведение»
