# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**The real product is the `my-old-space` framework** (a Win95-styled web desktop / form engine, installed from GitHub: `github:anfy1284/my-old-space`, living in `node_modules/my-old-space/`). This repo — a hotel-booking application ("Wonunger") — is a **reference application used as a testbed to drive framework development**: you extend the booking app, the gaps and bugs it exposes get fixed *in the framework*, and that is the point of the work.

Practical consequence: editing `node_modules/my-old-space/` is the **main activity, not a workaround**. When the booking app hits a limitation or a bug, the fix almost always belongs in a framework base class (so every app benefits), not in app-level code. Treat a local patch in `apps/` as a smell — find the root cause in the framework. (Caveat: `scripts/update-my-old-space.cmd` reinstalls from GitHub and overwrites local framework edits, so framework changes must eventually land upstream in the `anfy1284/my-old-space` repo.)

The most authoritative docs live inside the framework package and should be consulted for non-trivial work. They are **far more detailed than this CLAUDE.md** (which is only a high-level entry point) and currently describe **both the framework and this wonunger project** (the user plans to split them by concern later). They also ship with the framework package, so they apply to its own repo / other consumers too:
- `node_modules/my-old-space/ИНСТРУКЦИИ_ДЛЯ_AI.md` — coding rules, ~50-item anti-pattern catalog, ~64-item self-check checklist, deep i18n/UI/DB specifics (Russian). **Not auto-loaded, but read it in full proactively at the start of any non-trivial code/framework task — don't wait to be told.** It's only ~330 lines and the rules apply to almost all work here.
- `node_modules/my-old-space/АРХИТЕКТУРА_ПРОЕКТА.md` — full technical architecture reference: classes, methods, call chains, protocols (Russian). It's large (~2666 lines / 173 KB) — **consult the relevant section on demand (grep/read by topic); do NOT read it whole every session.**
- `FRAMEWORK_SETUP.md` (repo root) — bootstrap/deployment steps.

**Maintenance triggers (user commands, in Russian):**
- **«обнови инструкцию»** (or «дополни инструкции») → immediately review the *entire* current dialog, find your own mistakes and any newly-learned rules, and update these two framework docs accordingly — rules/anti-patterns/processes go in `ИНСТРУКЦИИ_ДЛЯ_AI.md`, technical structure (classes, methods, call chains) goes in `АРХИТЕКТУРА_ПРОЕКТА.md`, removing duplication between them. Do it without asking permission. Keep this CLAUDE.md in sync when a convention here is affected.
- **«сначала прочти инструкции»** → just an explicit re-read command; reading `ИНСТРУКЦИИ_ДЛЯ_AI.md` is already the default above. On this command also pull in the relevant `АРХИТЕКТУРА_ПРОЕКТА.md` sections for the task at hand.

## Commands

```bash
npm start          # node index.js — runs the server (port 3000, see server.config.json)
npm run dev        # nodemon index.js — auto-restart on change
```

There is **no test suite, linter, or build step**. Verification is done by running the server and exercising the UI. Ad-hoc debug scripts live in `scripts/` (e.g. `node debugModels.js`, `node scripts/collect_models.js`) — these are throwaway diagnostics, not a harness.

Update the framework from GitHub: run `scripts/update-my-old-space.cmd` (does `npm install git+https://github.com/anfy1284/my-old-space.git --save --force`). **Caution:** this overwrites any local edits made directly inside `node_modules/my-old-space/`.

## Database

Sequelize ORM against **PostgreSQL** (the active dialect). `dbSettings.json` selects the dialect; `dbSettings.postgres.json` holds credentials. Both are git-ignored. The schema is *not* migrated by hand — the framework reads every `apps/*/db/db.json` plus the framework's own model defs, merges them, and creates/syncs tables on startup. Seed data comes from `apps/*/db/defaultValues.json`.

Key DB conventions (violating these breaks things silently):
- **Never declare a `UID` field in `db.json`.** The primary key is a string `UID`, injected centrally by `events_handler.js#onModelsPostCollect` before `sequelize.define`. Adding it manually, or adding any other `primaryKey`, conflicts with the injection (Sequelize will otherwise invent a phantom `id` column).
- **Entities auto-get a `number` requisite + autonumber, documents also a `date`, and `name` is the computed presentation.** Any model with `entityConfig.entityType` (document/directory/catalog) systemically gets a string `number` field + `default.autoNumber` on it — like UID, injected by `drive_root/db/entityNumber.js` at migration (root `events_handler.js`) and runtime (`globalServerContext.collectAllModelDefs`); **documents additionally get a `date` field** (DATE) + `default.documentDate` (empty date = now on create; never touched on update) via `drive_root/db/entityDate.js`, same two injection points. Never declare `number`/`date`/`default.autoNumber` manually; manual entry is preserved. In hand-written layouts add `number`/`date` fields explicitly (custom layouts get no auto-additions). The `name` field is the **presentation** (display string), filled on every save by a builder registered via `entityHooks.registerPresentation(table, fn)` in the app's `init.js` — `applyPresentation` runs in the `dbGateway` middleware after autonumber. For bookings: `name = number + client + dates`; invoices: `number + client + date`; price lists: `number + hotel + date`. Anything needing the bare number (invoice "Nr.", etc.) must read `number`, not `name`. **Raw-SQL seeders** (`tmp/generate_demo_base.js`, `defaultValues.json`) bypass these hooks — set `number`/`name`/`date` there explicitly. Record-vs-list windows differ: `saveLayout` takes `recordCaption` (singular title + presentation) / `appCaption` (plural list title) and `formIcon`/`listIcon` (document vs journal icon by `entityType`); entity record windows and lists open maximized by default — don't hardcode `windowState`.
- **Always use `user.UID`, never `user.id`** anywhere in project or framework code. `user.id` returns `undefined` and silently destroys the access-control context.
- Empty-string values (`""`) are auto-converted to `null` for PostgreSQL in `dbGateway.js` — for FK fields (`references`) **and** nullable fields with validators (`allowNull && validate`, e.g. `email`/`isEmail`, since Sequelize skips validators only for `null`, not `""`).
- **Never hardcode VAT/tax rates as numbers.** Rates are data: global reference tables `tax_categories` + `tax_rates` (+ effective-dated links in `tax_category_rates`, `excluded_tables`, seeded in `apps/common/db/defaultValues.json`). Models reference a category (`services.taxCategoryId`, `service_tax_components.taxCategoryId`); the rate is resolved by service date (`resolveRate`/`rateByCode`/`svcRate` in `apps/invoice/forms/invoices.server.js`). A rate reform = one row edit, never a code edit. In document line grids the rate is **picked from `tax_rates`** (`invoice_lines.taxRateId`, `booking_extra_lines.taxRateId`) — no manually typed % anywhere; `invoice_lines.taxRate` keeps the resolved % only as a server-written point-in-time snapshot. A service can split into several VAT rates via `service_tax_components` (`splitMode` = `percent`/`amount`/`remainder`, e.g. breakfast → Speisen 7% + Getränke 19% from 2026-01-01). Full pricing/VAT rules live in `ПРАВИЛА_ЦЕНООБРАЗОВАНИЯ.md`.
- **Prices are documents, resolved only via `priceResolver`.** `room_prices`/`service_prices` are gone: accommodation/service prices live in «Price list» documents (`apps/priceList`: `price_lists` + two tabular sections) effective **from the document's `date`**; resolution is a "latest per position" slice (`apps/common/lib/priceResolver.js` — `loadSlice` once per calculation, then in-memory `pickRoomPrice`/`pickServicePrices`). Pricing date mode is an org setting (`pricingDateMode`: booking date vs invoice date, helper `resolveOrgPricingMode`). Invoices are standalone documents (`apps/invoice`: `invoices` + `invoice_bookings` + `invoice_lines`), created from a booking via `prepareFromBooking` → prefilled NEW form (no DB write until the user saves); invoice line grid stores exactly what prints (WYSIWYG — collapse happens at fill time, the print template does not regroup).

## Architecture

### Startup flow
`index.js` → `my-old-space`'s `start({ rootPath })` → sets `PROJECT_ROOT`, auto-loads the project-level `dbGateway.js`, starts `memory_store`, then runs the framework's `main_server.js`. Apps are discovered, models merged, DB synced, and each app's `init.js` registers its forms and menu items.

### App structure (`apps/`)
Apps are registered in `apps.json` (project) — the framework also keeps its own registry in `node_modules/my-old-space/drive_forms/apps.json`. Project apps: `common` (shared reference data — organizations, hotels, rooms, services, guest types, clients + `lib/priceResolver.js`), `booking` (the main document form), `priceList` (price-list documents), `invoice` (invoice documents + line calculation), `organizationSettings`, `reports`, `ai_chat`, `formula_editor`, `booking_icons` (applied icon assets). `booking_old` is dead/legacy (unregistered, references dropped tables).

The canonical app layout (use `apps/booking/` as the reference for everything):
```
apps/<app>/
  init.js                       # ~25-line glue: registers layouts, server scripts, hooks, menu items
  db/db.json                    # model/table/association definitions (no UID field!)
  db/defaultValues.json         # optional seed records with fixed UIDs
  hooks/<name>.js               # entity lifecycle hooks (registered via entityHooks.register)
  i18n.json                     # translations (en + ru minimum; de also used)
  forms/<table>.layout.json     # pure-JSON form layout (no code)
  forms/<table>.server.js       # factory: module.exports = (modelsDB, Utilities) => ({ ...fns })
  forms/<table>.client.js       # client JS; contains the literal placeholder __SERVER_SCRIPT__
```

**Split-file form pattern (required for any form with logic):** `init.js` calls `loadServerScript('app.actions', require('./forms/x.server')(modelsDB, Utilities), 'user')` to register the server module, reads the client file and `.replace(/__SERVER_SCRIPT__/g, serverScriptName)` to bind it, then `layoutMemory.saveLayout({...})` to register the layout against a `tableName`. Never hardcode the server-script name in the client file. Forms are rendered by the generic `uniForm` app driven by the saved layout — you rarely create a per-app UI app.

Server form functions receive `(params, ctx)` where `ctx = { sessionID, user, role }`. The first RPC argument is always a single `params` object.

### Access control / Row-Level Security
`dbGateway.js` (repo root) registers an **app-level middleware** that runs before every DB operation. It resolves the user *only* from `sessionID` (never trusts a passed `userId`/`role`), then constrains `read/findOne/count/update/delete` to rows the user may see, filtering by `organizationId` / `hotelId` / `userId` (the `required_access_fields` in `app.config.json`).
- `admin` role bypasses filtering.
- Tables in `excluded_tables` (`app.config.json`) are skipped — these are global reference tables. `organizations` is excluded but still gets a special-cased RLS filter by its own `UID`.
- **Internal/system calls** must pass `context.sessionID === '__SYS_INTERNAL__'` (`SYSTEM_SESSION_ID`) to bypass RLS — never pass a fake `userId`/`role` instead. Grep `__SYS_INTERNAL__` to audit every bypass.
- Policy: every non-excluded table **must** have at least one `required_access_field`; this is validated at startup.

### i18n
User-visible strings must be translated. Server code: `tForSession`/`tfForSession` (from `drive_forms/globalServerContext`). Static client `.js`: the `__t('key')` marker. Layout/db captions: `{ "i18n": "key" }` objects, resolved at render time. Add new keys to all relevant `i18n.json` files in one pass — languages in use are **en, ru, de, pl** (a missing code silently falls back to `en`). Before deleting a key, grep the whole project *and* `node_modules/my-old-space` for it.

Two distinct translation layers (don't conflate): **(1) `i18n.json`** translates UI strings by key (above). **(2) the `translations` table** (+ `translationMiddleware.js`) translates reference *data* — the `name` value of records in tables with a `translatable: true` field (e.g. `guest_types`, `booking_statuses`); add per-language rows in `apps/common/db/defaultValues.json`. Reference data the *user* enters (services, room names, clients) is single-language by design.

**Documents are in the organization's language, not the user's.** Invoices/reports build their content (incl. line texts) from the org's `reportLanguage` (`organizationSettings`), resolved via `resolveOrgReportLang(modelsDB, orgId)` in `apps/organizationSettings/lib/orgReportLanguage.js` — used by both `reports/init.js` and `booking`'s `_buildInvoiceLines`. Never use `tForSession` (session language) for document content.

**Adding a UI language** is not one row: add it to `languages` (`drive_root/db/defaultValues.json`), add the code to *all* `i18n.json`, add `translations` rows for reference data, add a locale-format mapping (`pl → 'pl-PL'`), then restart (i18n loads into the registry at startup; `languages`/`translations` are re-seeded each startup by `createDB.js`). User language change is only visible after a page reload — `UserSettings.saveSettings` returns `languageChanged` and the client calls `location.reload()`. Any server cache of *translated* values must key by language (see the `getLookupList` `_lookupCache` fix). Full mechanism: section 20 of `АРХИТЕКТУРА_ПРОЕКТА.md`.

### Events / hooks
- Project `events_handler.js` (repo root) **must** use CommonJS `module.exports = {...}` — `export default` makes the framework silently ignore it. Framework's root `events_handler.js` runs first, then the project's. Key hooks: `onModelsPostCollect` (UID injection), `onDatabasePostInit` (post-sync seeding).
- Entity lifecycle hooks are declared in a model's `entityConfig.hooks` in `db.json` (e.g. `beforeCreate: [{ handler: "booking.onBeforeCreate" }]`) and the handler is registered in the app's `init.js` via `entityHooks.register(name, fn)`.

## Conventions that matter

- **Editing files:** use file-editing tools, not shell redirection/`sed`/`echo >` — keeps changes reviewable/revertible.
- **Editing the framework is the main job** (see "What this is"): fix bugs at their root in the framework base classes, not with patches in `apps/`.
- **Pattern-first:** before writing anything new, copy the matching pattern from `apps/booking/`. Deviating from an established pattern needs explicit justification.
- **Don't paper over framework limitations with naming/data conventions** — fix the framework instead.
- **UI is Win95-styled:** reports/documents open *inside* a Win95 window via `MySpace.open('printPreview', { html })`, not `window.open(..., '_blank')`. Build buttons with the `Button` class (`new Button()` → `btn.Draw(container)`), not raw `document.createElement('button')`. New client apps follow the `createInstance` pattern and need `autoStart: true` in their `config.json` plus registration in `drive_forms/apps.json`.
- **Icons are mandatory** on every UI element (button, menu item, table column, toolbar action) via the `icon` property. Catalog: `D:\wohnunger_icons\ICONS_CATALOG.txt`. System icons: `/apps/general_icons/resources/public/16x16/<id>.png`. Applied icons: `/apps/booking_icons/resources/public/16x16/<id>.png`. To add one: create `D:\wohnunger_icons\scripts\icons/<collection>/<id>.py`, run `python scripts/generate_all.py`, update the catalog, then `python scripts/deploy.py`.
- Static assets are only served from `apps/<app>/resources/public/` → URL `/apps/<app>/resources/public/<file>`.

Note: most in-repo documentation and code comments are in Russian.
