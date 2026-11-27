import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { createDemoStore, DEMO_STORAGE_KEY, DEMO_LOCK, hongKongDay } from '../demo/store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function memory() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function webLocks() {
  let queue = Promise.resolve();
  return { request(name, action) {
    assert.equal(name, DEMO_LOCK);
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  } };
}
function fixture() {
  const storage = memory(), locks = webLocks();
  let now = new Date('2026-11-17T03:00:00.000Z');
  const options = { storage, locks, clock: () => now };
  return { storage, store: createDemoStore(options), another: () => createDemoStore(options), clock: (value) => { now = new Date(value); } };
}
const input = (extra = {}) => ({ day: '2026-11-17', type: 'strength', bodyPart: 'Legs', exercise: 'Test squat', sets: 4, reps: 15, notes: '', ...extra });
const write = (store, path, body, method = 'POST') => store.request(path, { method, body: JSON.stringify(body) });
const month = (store, value = '2026-11') => store.request('/api/records?month=' + value);
const error = (code, status) => (failure) => failure.code === code && (status === undefined || failure.status === status);

test('Hong Kong day changes at UTC 16:00, including month and leap boundaries', () => {
  assert.equal(hongKongDay(new Date('2026-11-30T15:59:59Z')), '2026-11-30');
  assert.equal(hongKongDay(new Date('2026-11-30T16:00:00Z')), '2026-12-01');
  assert.equal(hongKongDay(new Date('2028-02-28T16:00:00Z')), '2028-02-29');
});

test('demo boot has no account and seeds fictional strength and cardio', async () => {
  const { store } = fixture();
  assert.deepEqual(await store.request('/api/auth/status'), { authenticated: true, user: null, show_default_credentials: false, today: '2026-11-17' });
  const result = await month(store);
  assert.equal(result.records.length, 4);
  assert.ok(result.records.some((record) => record.type === 'strength'));
  assert.ok(result.records.some((record) => record.type === 'cardio'));
  assert.ok(result.records.every((record) => record.notes.startsWith('Fictional sample.')));
});

test('records persist through a fresh store on the same day', async () => {
  const f = fixture();
  const saved = await write(f.store, '/api/records', input());
  const records = (await month(f.another())).records;
  assert.deepEqual(records.find((record) => record.id === saved.record.id), saved.record);
});

test('create/edit/delete/export follow the private API shape and preserve versions', async () => {
  const { store } = fixture();
  const created = (await write(store, '/api/records', input())).record;
  assert.equal(created.version, 1);
  const updated = (await write(store, '/api/records/' + created.id, { ...input({ reps: 10 }), version: 1 }, 'PATCH')).record;
  assert.equal(updated.reps, 10);
  assert.equal(updated.version, 2);
  await assert.rejects(write(store, '/api/records/' + created.id, { version: 1 }, 'DELETE'), error('RECORD_CHANGED', 409));
  assert.deepEqual(await write(store, '/api/records/' + created.id, { version: 2 }, 'DELETE'), { ok: true });
  await assert.rejects(write(store, '/api/records/' + created.id, { ...input(), version: 2 }, 'PATCH'), error('NOT_FOUND', 404));
  const backup = await store.request('/api/export');
  assert.equal(backup.format, 'exercise');
  assert.equal(backup.version, 1);
  assert.equal(backup.records.length, 4);
  assert.equal(backup.user, undefined);
});

test('sets and reps reject fractional, boolean, string and out-of-range values', async () => {
  const { store } = fixture();
  for (const key of ['sets', 'reps']) {
    for (const value of [1.5, true, '4', 0, -1, 10001, null]) {
      await assert.rejects(write(store, '/api/records', input({ [key]: value })), error('INVALID_' + key.toUpperCase()));
    }
  }
});

test('cardio accepts decimal duration/distance and rejects invalid type mixtures', async () => {
  const { store } = fixture();
  const cardio = { day: '2026-11-17', type: 'cardio', exercise: 'Test run', duration: 25.5, distance: 4.25 };
  assert.equal((await write(store, '/api/records', cardio)).record.duration, 25.5);
  for (const value of [0, -1, true, '30', 10081, Infinity]) {
    await assert.rejects(write(store, '/api/records', { ...cardio, duration: value }), error('INVALID_DURATION'));
  }
  await assert.rejects(write(store, '/api/records', { ...cardio, sets: 3 }), error('INVALID_CARDIO'));
  await assert.rejects(write(store, '/api/records', input({ duration: 30 })), error('INVALID_STRENGTH'));
});

test('strength weight is optional and bounded while cardio rejects it', async () => {
  const { store } = fixture();
  assert.equal((await write(store, '/api/records', input({ weight: 60 }))).record.weight, 60);
  assert.equal((await write(store, '/api/records', input())).record.weight, null);
  for (const value of [0, -1, true, '60', 10001]) {
    await assert.rejects(write(store, '/api/records', input({ weight: value })), error('INVALID_WEIGHT'));
  }
  const cardio = { day: '2026-11-17', type: 'cardio', exercise: 'Test run', duration: 20, weight: 50 };
  await assert.rejects(write(store, '/api/records', cardio), error('INVALID_CARDIO'));
});

test('real dates, month queries, unknown fields and malformed JSON are checked', async () => {
  const { store } = fixture();
  for (const day of ['2026-02-29', '2026-11-31', '1899-12-31', '9999-01-01']) await assert.rejects(write(store, '/api/records', input({ day })), error('INVALID_DATE'));
  await write(store, '/api/records', input({ day: '2028-02-29' }));
  assert.equal((await month(store, '2028-02')).records.length, 1);
  await assert.rejects(store.request('/api/records?month=2026-11&month=2026-12'), error('INVALID_QUERY'));
  await assert.rejects(month(store, 'nonsense'), error('INVALID_MONTH'));
  await assert.rejects(write(store, '/api/records', input({ account: 1 })), error('UNKNOWN_FIELDS'));
  await assert.rejects(write(store, '/api/records', input({ notes: null })), error('INVALID_NOTES'));
  await assert.rejects(store.request('/api/records', { method: 'POST', body: '{' }), error('INVALID_JSON'));
});

test('authentication, account and external-origin requests are unavailable', async () => {
  const { store } = fixture();
  for (const path of ['/api/auth/login', '/api/auth/logout', '/api/account', 'https://daily.kylermaker.com/api/records']) {
    await assert.rejects(write(store, path, {}), error('NOT_FOUND', 404));
  }
});

test('parallel tabs retain every write through shared Web Locks', async () => {
  const f = fixture(), second = f.another();
  await month(f.store);
  await Promise.all(Array.from({ length: 60 }, (_, index) => write(index % 2 ? f.store : second, '/api/records', input({ exercise: 'Parallel ' + index }))));
  const records = (await month(f.store)).records;
  assert.equal(records.length, 64);
  assert.equal(new Set(records.map((record) => record.id)).size, records.length);
});

test('competing edits accept exactly one version and reject the stale tab', async () => {
  const f = fixture(), second = f.another();
  const original = (await write(f.store, '/api/records', input())).record;
  const edits = await Promise.allSettled([write(f.store, '/api/records/' + original.id, { ...input({ reps: 8 }), version: 1 }, 'PATCH'), write(second, '/api/records/' + original.id, { ...input({ reps: 9 }), version: 1 }, 'PATCH')]);
  assert.equal(edits.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(edits.find((item) => item.status === 'rejected').reason.code, 'RECORD_CHANGED');
});

test('Hong Kong midnight resets daily and never reuses a stale record ID', async () => {
  const f = fixture();
  const old = (await write(f.store, '/api/records', input())).record;
  f.clock('2026-11-17T16:00:00.000Z');
  assert.equal((await f.store.refresh()).day, '2026-11-18');
  const result = await month(f.store);
  assert.equal(result.records.length, 4);
  assert.equal(result.records.find((record) => record.id === old.id), undefined);
  await assert.rejects(write(f.store, '/api/records/' + old.id, { ...input(), version: old.version }, 'PATCH'), error('NOT_FOUND'));
});

test('explicit reset recovers damaged state and creates fresh sample IDs', async () => {
  const f = fixture();
  const ids = (await month(f.store)).records.map((record) => record.id);
  await f.store.reset();
  assert.ok((await month(f.store)).records.every((record) => !ids.includes(record.id)));
  f.storage.setItem(DEMO_STORAGE_KEY, '{broken');
  await assert.rejects(month(f.store), error('DEMO_STORAGE_INVALID', 503));
  assert.equal(f.storage.getItem(DEMO_STORAGE_KEY), '{broken');
  await f.store.reset();
  assert.equal((await month(f.store)).records.length, 4);
});

test('structurally corrupt saved records remain untouched until reset', async () => {
  const f = fixture();
  await month(f.store);
  const state = JSON.parse(f.storage.getItem(DEMO_STORAGE_KEY));
  state.records[0].sets = '4';
  const raw = JSON.stringify(state);
  f.storage.setItem(DEMO_STORAGE_KEY, raw);
  await assert.rejects(month(f.store), error('DEMO_STORAGE_INVALID'));
  assert.equal(f.storage.getItem(DEMO_STORAGE_KEY), raw);
});

test('blocked storage and unavailable Web Locks return explicit recoverable errors', async () => {
  const store = createDemoStore({ storage: { getItem() { throw new Error('blocked'); } }, locks: webLocks() });
  await assert.rejects(month(store), error('DEMO_STORAGE_ERROR', 503));
  const unsupported = createDemoStore({ storage: memory(), locks: null });
  await assert.rejects(month(unsupported), error('DEMO_LOCK_UNAVAILABLE', 503));
});

test('quota failures retain the last saved records', async () => {
  const f = fixture();
  await month(f.store);
  const saved = f.storage.getItem(DEMO_STORAGE_KEY);
  f.storage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(write(f.store, '/api/records', input()), error('DEMO_STORAGE_ERROR'));
  assert.equal(f.storage.getItem(DEMO_STORAGE_KEY), saved);
});

test('clock rollback never silently replaces or overwrites demo records', async () => {
  const f = fixture();
  await month(f.store);
  const saved = f.storage.getItem(DEMO_STORAGE_KEY);
  f.clock('2026-11-16T02:00:00.000Z');
  await assert.rejects(month(f.store), error('DEMO_CLOCK_ERROR', 409));
  assert.equal(f.storage.getItem(DEMO_STORAGE_KEY), saved);
  f.clock('2026-11-17T02:00:00.000Z');
  await assert.rejects(write(f.store, '/api/records', input()), error('DEMO_CLOCK_ERROR', 409));
  assert.equal(f.storage.getItem(DEMO_STORAGE_KEY), saved);
});

test('generator publishes only the public whitelist and a network-free adapter', () => {
  const output = mkdtempSync(resolve(tmpdir(), 'exercise-demo-check-'));
  try {
    const built = spawnSync(process.execPath, [resolve(root, 'scripts/build-demo.mjs'), output], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    const files = readdirSync(output);
    for (const name of ['login.html', 'login.mjs', 'server.py', '.env', 'data', 'exercise.sqlite3']) assert.ok(!files.includes(name));
    for (const name of ['index.html', 'app.js', 'auth.mjs', 'demo-store.mjs', 'demo-banner.mjs', 'demo.css']) assert.ok(files.includes(name));
    for (const name of files.filter((file) => /\.(js|mjs)$/.test(file))) {
      const source = readFileSync(resolve(output, name), 'utf8');
      assert.doesNotMatch(source, /\bfetch\s*\(/, name);
      const syntax = spawnSync(process.execPath, ['--check', resolve(output, name)], { encoding: 'utf8' });
      assert.equal(syntax.status, 0, syntax.stderr);
      for (const match of source.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)) assert.ok(files.includes(match[1]), name + ' missing import ' + match[1]);
    }
    assert.match(readFileSync(resolve(output, '_headers'), 'utf8'), /connect-src 'none'/);
    assert.match(readFileSync(resolve(output, 'auth.mjs'), 'utf8'), /export const takeRecordDraft/);
    const generatedApp = readFileSync(resolve(output, 'app.js'), 'utf8');
    const hook = generatedApp.slice(generatedApp.lastIndexOf('window.addEventListener("exercise-demo-update"'));
    let callback, refreshes = 0, exerciseRefreshes = 0;
    runInNewContext(hook, { authenticated: true, loading: true, document: { querySelector: () => ({ open: true }) },
      window: { addEventListener: (name, action) => { callback = action; } }, loadMonth: () => { refreshes++; }, loadExercises: () => { exerciseRefreshes++; } });
    callback();
    assert.equal(refreshes, 1, 'Cross-tab updates must refresh cached records while a modal is open or a load is pending.');
    assert.equal(exerciseRefreshes, 1, 'Cross-tab updates must refresh saved exercises.');
    writeFileSync(resolve(output, 'sentinel.txt'), 'keep');
    assert.notEqual(spawnSync(process.execPath, [resolve(root, 'scripts/build-demo.mjs'), output]).status, 0);
    assert.equal(readFileSync(resolve(output, 'sentinel.txt'), 'utf8'), 'keep');
  } finally { rmSync(output, { recursive: true, force: true }); }
});

test('saved exercises seed, add, reject duplicates and delete', async () => {
  const { store } = fixture();
  const seeded = (await store.request('/api/exercises')).exercises;
  assert.ok(seeded.length >= 4);
  assert.ok(seeded.every((item) => item.name.startsWith('Demo')));
  const added = (await write(store, '/api/exercises', { type: 'strength', bodyPart: 'Arms', name: 'Test curl' })).exercise;
  await assert.rejects(write(store, '/api/exercises', { type: 'strength', bodyPart: 'Arms', name: 'Test curl' }), error('EXERCISE_EXISTS', 409));
  await assert.rejects(write(store, '/api/exercises', { type: 'cardio', bodyPart: 'Legs', name: 'x' }), error('INVALID_CARDIO'));
  assert.deepEqual(await write(store, '/api/exercises/' + added.id, {}, 'DELETE'), { ok: true });
  await assert.rejects(write(store, '/api/exercises/' + added.id, {}, 'DELETE'), error('NOT_FOUND', 404));
  assert.equal((await store.request('/api/exercises')).exercises.length, seeded.length);
});
