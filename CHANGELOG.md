# Changelog

## 0.1.4 — 2026-11-23

- Record an optional weight (kg, up to 10000) on strength entries, shown in its own column and in the calendar, day, and monthly shorthand (e.g. 腿：深蹲 60kg × 4 × 15). Cardio still rejects weight; existing databases are migrated non-destructively.
- Mirror the weight field in the Cloudflare Pages demo's browser-local store.

## 0.1.3 — 2026-11-17

- Keep the first navigation click reliable after committing a text month field; Enter and blur no longer trigger duplicate month reloads.

## 0.1.2 — 2026-11-17

- Show a usable YYYY-MM month field when a browser does not support native month pickers, including Safari/WebKit.
- Reject invalid or out-of-range months without changing the selected date or crashing calendar rendering.
- Add actual WebKit regression coverage alongside the existing Chromium mobile tests.

## 0.1.1 — 2026-11-17

- Align strength and cardio inputs across mobile layouts and languages, including wrapped Optional labels; prevent English and Spanish navigation text from overlapping.
- Refresh stale record versions after edit/delete conflicts while preserving unsaved input.
- Read the current server date for Today and ignore outdated date-navigation responses.
- Preserve workout drafts through session expiry and sign-in, with a visible fallback when browser storage is unavailable.
- Revalidate sessions inside write transactions so revoked sessions cannot complete delayed requests.
- Serialize launcher operations and retain separate process ownership for each port.
- Return a valid error for malformed request URLs and safely reject malformed health responses.
- Add an isolated Cloudflare Pages demo with fictional browser-local data, daily Hong Kong reset, concurrent-tab protection, and explicit reset controls.
- Add isolated browser, backend, launcher, model, and demo regression tests.

## 0.1.0 — 2026-11-16

- Initial private training journal with strength and cardio records, daily editing, calendar, continuous monthly reports, account management, ten themes, four languages, and JSON export.
