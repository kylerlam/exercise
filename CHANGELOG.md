# Changelog

## 0.1.9 — 2026-11-27

- Import: Settings sidebar gains **Import data**. It merges an Exercise JSON export (version 1 or 2, up to 5 MB): records and saved exercises that are not already present are added, existing ones are kept, and an invalid entry rejects the whole file.
- Export now includes the saved exercise list (export format version 2).
- Saved exercise rows link to the Gym exercise library search for a demo.
- Login rate limiting counts the visitor address from Cloudflare's `CF-Connecting-IP` for requests from `TRUSTED_PROXY_IPS`, so other visitors' failed attempts can no longer lock out the owner.
- HTTPS deployments send HSTS. New passwords need at least 12 characters, matching the other apps.
- Fix: Settings showed v0.1.5 instead of the running version.

## 0.1.8 — 2026-11-27

- Strength exercises now have a measure: reps or seconds. Holds such as planks are recorded as sets × seconds per set instead of being forced into reps.
- The Exercises table gains a Measure column, switchable per row; on upgrade, saved exercises named like plank / side plank / wall sit are set to seconds. Existing records stay in reps.
- In the record dialog, the Reps label is a reps/seconds switch that follows the picked exercise and can be changed for manually typed moves.
- Monthly summary adds "Timed seconds" (sets × seconds); timed holds no longer inflate total reps. Records, calendar and monthly lines show e.g. "× 4 × 60 s".
- Dropdowns in the record dialog now match the height of the input boxes beside them.

## 0.1.7 — 2026-11-27

- Fix: after the 0.1.6 release, Cloudflare kept serving the old `app.js` to browsers, so the Exercises tab fell back to the calendar. The server now tags every script, stylesheet and module import with the release version so cached files can never mix versions.
- The Exercises page is now a table: an entry row (body part, exercise, Add) above one row per saved exercise, with separate strength and cardio tables.
- In the record dialog, body part and exercise are dropdowns; picking a body part narrows the exercise list, and "Other (type manually)" keeps free typing available.

## 0.1.6 — 2026-11-27

- Add an Exercises page between Daily records and Calendar to save frequently used strength moves (by body part) and cardio activities, with duplicate protection and removal that leaves past records unchanged.
- The record dialog offers a "pick a saved exercise" list that fills the body part and exercise name; manual entry still works.
- On upgrade, every distinct exercise already present in training records is imported once into the library.
- Mirror the library in the Cloudflare Pages demo; phone navigation now stacks icons above labels to fit four tabs.

## 0.1.5 — 2026-11-23

- Calendar day cells now show the trained body parts, de-duplicated in entry order (e.g. 胸·背), instead of the first exercise name plus a count; cardio-only days still show the activity name.

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
