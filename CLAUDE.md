# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**The real product is the `my-old-space` framework** (a Win95-styled web desktop / form engine, installed from GitHub: `github:anfy1284/my-old-space`, living in `node_modules/my-old-space/`). This repo — a hotel-booking application ("Wonunger") — is a **reference application used as a testbed to drive framework development**: you extend the booking app, the gaps and bugs it exposes get fixed *in the framework*, and that is the point of the work.

Practical consequence: editing `node_modules/my-old-space/` is the **main activity, not a workaround**. When the booking app hits a limitation or a bug, the fix almost always belongs in a framework base class (so every app benefits), not in app-level code. Treat a local patch in `apps/` as a smell — find the root cause in the framework. (Caveat: `scripts/update-my-old-space.cmd` reinstalls from GitHub and overwrites local framework edits, so framework changes must eventually land upstream in the `anfy1284/my-old-space` repo.)

The most authoritative docs live inside the framework package and should be consulted for non-trivial work:
- `node_modules/my-old-space/ИНСТРУКЦИИ_ДЛЯ_AI.md` — coding rules, anti-patterns, self-check checklist (Russian).
- `node_modules/my-old-space/АРХИТЕКТУРА_ПРОЕКТА.md` — full architecture reference (173 KB, Russian).
- `FRAMEWORK_SETUP.md` (repo root) — bootstrap/deployment steps.

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
- **Always use `user.UID`, never `user.id`** anywhere in project or framework code. `user.id` returns `undefined` and silently destroys the access-control context.
- Empty-string FK values (`""`) are auto-converted to `null` for PostgreSQL — done in `dbGateway.js`.

## Architecture

### Startup flow
`index.js` → `my-old-space`'s `start({ rootPath })` → sets `PROJECT_ROOT`, auto-loads the project-level `dbGateway.js`, starts `memory_store`, then runs the framework's `main_server.js`. Apps are discovered, models merged, DB synced, and each app's `init.js` registers its forms and menu items.

### App structure (`apps/`)
Apps are registered in `apps.json` (project) — the framework also keeps its own registry in `node_modules/my-old-space/drive_forms/apps.json`. Project apps: `common` (shared reference data — organizations, hotels, rooms, services, guest types, clients), `booking` (the main document form), `reports`, `ai_chat`, `booking_icons` (applied icon assets). `booking_old` is dead/legacy.

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
User-visible strings must be translated. Server code: `tForSession`/`tfForSession` (from `drive_forms/globalServerContext`). Static client `.js`: the `__t('key')` marker. Layout/db captions: `{ "i18n": "key" }` objects, resolved at render time. Add new keys to all relevant `i18n.json` files (en + ru at minimum) in one pass. Before deleting a key, grep the whole project *and* `node_modules/my-old-space` for it.

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
