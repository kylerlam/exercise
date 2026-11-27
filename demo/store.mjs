export const DEMO_STORAGE_KEY = 'exercise-demo-v4';
export const DEMO_LOCK = 'exercise-demo-write';

function fail(code, status = 400) {
  throw Object.assign(new Error(code), { code, status });
}

export function hongKongDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map((name) => parts.find((part) => part.type === name).value).join('-');
}

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_BODY');
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('UNKNOWN_FIELDS');
}

function text(value, label, min = 0, max = 100) {
  if (typeof value !== 'string' || [...value].length < min || [...value].length > max ||
      [...value].some((char) => char.codePointAt(0) >= 0xd800 && char.codePointAt(0) <= 0xdfff)) fail('INVALID_' + label);
  return value;
}

function integer(value, label, max = 10000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('INVALID_' + label);
  return value;
}

function positive(value, label, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) fail('INVALID_' + label);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '9998-12-31') fail('INVALID_DATE');
  const parsed = new Date(value + 'T12:00:00Z');
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail('INVALID_DATE');
  return value;
}

const RECORD_FIELDS = ['day', 'type', 'bodyPart', 'exercise', 'sets', 'reps', 'unit', 'weight', 'duration', 'distance', 'notes'];
function validUnit(value, type) {
  if (!['reps', 'seconds'].includes(value) || (type === 'cardio' && value !== 'reps')) fail('INVALID_UNIT');
  return value;
}
function validateRecord(data, editing = false) {
  fields(data, [...RECORD_FIELDS, ...(editing ? ['version'] : [])]);
  const record = {
    day: validDate(data.day), type: data.type,
    bodyPart: text(data.bodyPart === undefined ? '' : data.bodyPart, 'BODY_PART', 0, 60).trim(),
    exercise: text(data.exercise, 'EXERCISE', 1, 100).trim(),
    sets: data.sets ?? null, reps: data.reps ?? null, unit: data.unit ?? 'reps', weight: data.weight ?? null,
    duration: data.duration ?? null, distance: data.distance ?? null,
    notes: text(data.notes === undefined ? '' : data.notes, 'NOTES', 0, 2000),
  };
  if (!record.exercise) fail('INVALID_EXERCISE');
  if (record.type === 'strength') {
    if (!record.bodyPart) fail('INVALID_BODY_PART');
    integer(record.sets, 'SETS');
    integer(record.reps, 'REPS');
    if (record.weight !== null) positive(record.weight, 'WEIGHT', 10000);
    if (record.duration !== null || record.distance !== null) fail('INVALID_STRENGTH');
  } else if (record.type === 'cardio') {
    if (record.bodyPart || record.sets !== null || record.reps !== null || record.weight !== null) fail('INVALID_CARDIO');
    positive(record.duration, 'DURATION', 10080);
    if (record.distance !== null) positive(record.distance, 'DISTANCE', 100000);
  } else fail('INVALID_TYPE');
  validUnit(record.unit, record.type);
  if (editing) integer(data.version, 'VERSION', 2 ** 31 - 1);
  return record;
}

function validateExercise(data) {
  fields(data, ['type', 'bodyPart', 'name', 'unit']);
  const item = { type: data.type, bodyPart: text(data.bodyPart === undefined ? '' : data.bodyPart, 'BODY_PART', 0, 60).trim(), name: text(data.name, 'EXERCISE', 1, 100).trim(), unit: data.unit ?? 'reps' };
  if (!item.name) fail('INVALID_EXERCISE');
  if (item.type === 'strength') { if (!item.bodyPart) fail('INVALID_BODY_PART'); }
  else if (item.type === 'cardio') { if (item.bodyPart) fail('INVALID_CARDIO'); }
  else fail('INVALID_TYPE');
  validUnit(item.unit, item.type);
  return item;
}

function validStored(value) {
  fields(value, ['format', 'version', 'day', 'updatedAt', 'nextId', 'records', 'exercises']);
  if (value.format !== 'exercise-demo' || value.version !== 3 || !Array.isArray(value.records) || !Array.isArray(value.exercises)) fail('DEMO_STORAGE_INVALID');
  validDate(value.day);
  if (typeof value.updatedAt !== 'string' || new Date(value.updatedAt).toISOString() !== value.updatedAt) fail('DEMO_STORAGE_INVALID');
  integer(value.nextId, 'ID', Number.MAX_SAFE_INTEGER);
  const ids = new Set();
  for (const record of value.records) {
    fields(record, [...RECORD_FIELDS, 'id', 'version', 'created_at', 'updated_at']);
    if (Object.keys(record).length !== RECORD_FIELDS.length + 4) fail('DEMO_STORAGE_INVALID');
    const input = Object.fromEntries(RECORD_FIELDS.map((key) => [key, record[key]]));
    validateRecord(input);
    integer(record.id, 'ID', Number.MAX_SAFE_INTEGER);
    integer(record.version, 'VERSION', 2 ** 31 - 1);
    if (ids.has(record.id) || record.id >= value.nextId) fail('DEMO_STORAGE_INVALID');
    ids.add(record.id);
    for (const key of ['created_at', 'updated_at']) {
      if (typeof record[key] !== 'string' || new Date(record[key]).toISOString() !== record[key]) fail('DEMO_STORAGE_INVALID');
    }
    if (record.created_at > record.updated_at || record.updated_at > value.updatedAt) fail('DEMO_STORAGE_INVALID');
  }
  const keys = new Set();
  for (const item of value.exercises) {
    fields(item, ['id', 'type', 'bodyPart', 'name', 'unit', 'created_at']);
    const valid = validateExercise({ type: item.type, bodyPart: item.bodyPart, name: item.name, unit: item.unit });
    integer(item.id, 'ID', Number.MAX_SAFE_INTEGER);
    const key = JSON.stringify([valid.type, valid.bodyPart, valid.name]);
    if (ids.has(item.id) || item.id >= value.nextId || keys.has(key) || typeof item.created_at !== 'string') fail('DEMO_STORAGE_INVALID');
    ids.add(item.id);
    keys.add(key);
  }
  return value;
}

function examples(now, nextId) {
  const day = hongKongDay(now), at = now.toISOString();
  const offset = (days) => new Date(new Date(day + 'T12:00:00Z').valueOf() + days * 86400000).toISOString().slice(0, 10);
  const state = { format: 'exercise-demo', version: 3, day, updatedAt: at, nextId, records: [], exercises: [] };
  for (const input of [
    { day: offset(-3), type: 'strength', bodyPart: 'Back', exercise: 'Demo row', sets: 3, reps: 12 },
    { day: offset(-1), type: 'cardio', exercise: 'Demo cycling', duration: 25, distance: 7.5 },
    { day, type: 'strength', bodyPart: 'Legs', exercise: 'Demo squat', sets: 4, reps: 15, weight: 60 },
    { day, type: 'cardio', exercise: 'Demo walk', duration: 30, distance: 2.5 },
  ]) state.records.push({ ...validateRecord({ ...input, notes: 'Fictional sample. Edit freely or reset this demo.' }), id: state.nextId++, version: 1, created_at: at, updated_at: at });
  for (const [type, bodyPart, name, unit = 'reps'] of [['strength', 'Back', 'Demo row'], ['strength', 'Legs', 'Demo squat'], ['strength', 'Chest', 'Demo push-up'], ['strength', 'Core', 'Demo plank', 'seconds'], ['cardio', '', 'Demo cycling'], ['cardio', '', 'Demo walk']]) {
    state.exercises.push({ id: state.nextId++, type, bodyPart, name, unit, created_at: at });
  }
  return state;
}

export function createDemoStore({ storage, locks = globalThis.navigator?.locks, clock = () => new Date() } = {}) {
  function access(action) {
    try { return action(storage === undefined ? globalThis.localStorage : storage); }
    catch { fail('DEMO_STORAGE_ERROR', 503); }
  }
  const save = (state) => access((target) => target.setItem(DEMO_STORAGE_KEY, JSON.stringify(state)));
  function seed(now, previous) {
    // IDs survive resets so an old tab cannot overwrite a newly seeded record.
    const state = examples(now, Math.max(now.valueOf() * 1000, previous?.nextId ?? 1));
    save(state);
    return state;
  }
  function read(now) {
    const raw = access((target) => target.getItem(DEMO_STORAGE_KEY));
    if (raw === null) return seed(now);
    let state;
    try { state = validStored(JSON.parse(raw)); }
    catch { fail('DEMO_STORAGE_INVALID', 503); }
    const day = hongKongDay(now);
    if (day < state.day) fail('DEMO_CLOCK_ERROR', 409);
    return day > state.day ? seed(now, state) : state;
  }
  function serial(action) {
    if (!locks?.request) return Promise.reject(Object.assign(new Error('DEMO_LOCK_UNAVAILABLE'), { code: 'DEMO_LOCK_UNAVAILABLE', status: 503 }));
    return locks.request(DEMO_LOCK, () => action(clock()));
  }
  const copy = (value) => structuredClone(value);
  function reset() {
    return serial((now) => {
      let previous;
      const raw = access((target) => target.getItem(DEMO_STORAGE_KEY));
      try { previous = raw === null ? undefined : validStored(JSON.parse(raw)); } catch { /* Explicit reset replaces invalid data. */ }
      return copy(seed(now, previous));
    });
  }
  async function request(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const url = new URL(path, 'https://exercise-demo.invalid');
    if (url.origin !== 'https://exercise-demo.invalid') fail('NOT_FOUND', 404);
    if (url.pathname === '/api/auth/status' && method === 'GET') return { authenticated: true, user: null, show_default_credentials: false, today: hongKongDay(clock()) };
    const isRead = method === 'GET' && ['/api/records', '/api/export', '/api/exercises'].includes(url.pathname);
    const match = /^\/api\/records\/([1-9]\d*)$/.exec(url.pathname);
    const exerciseMatch = /^\/api\/exercises\/([1-9]\d*)$/.exec(url.pathname);
    const exerciseWrite = (method === 'POST' && url.pathname === '/api/exercises') || (exerciseMatch && ['PATCH', 'DELETE'].includes(method));
    if (!isRead && !exerciseWrite && !(method === 'POST' && url.pathname === '/api/records') && !(match && ['PATCH', 'DELETE'].includes(method))) fail('NOT_FOUND', 404);
    let input;
    if (method !== 'GET') {
      try { input = JSON.parse(options.body); } catch { fail('INVALID_JSON'); }
    }
    return serial((now) => {
      const state = read(now);
      if (isRead && url.pathname === '/api/export') {
        if ([...url.searchParams].length) fail('INVALID_QUERY');
        return copy({ format: 'exercise', version: 2, exported_at: now.toISOString(), records: [...state.records].sort((a, b) => a.day.localeCompare(b.day) || a.id - b.id), exercises: [...state.exercises].sort((a, b) => b.type.localeCompare(a.type) || a.id - b.id) });
      }
      if (isRead && url.pathname === '/api/exercises') {
        if ([...url.searchParams].length) fail('INVALID_QUERY');
        return copy({ exercises: [...state.exercises].sort((a, b) => b.type.localeCompare(a.type) || a.id - b.id) });
      }
      if (isRead) {
        const values = url.searchParams.getAll('month');
        if ([...url.searchParams].length !== 1 || values.length !== 1) fail('INVALID_QUERY');
        if (!/^\d{4}-\d{2}$/.test(values[0])) fail('INVALID_MONTH');
        validDate(values[0] + '-01');
        return copy({ records: state.records.filter((record) => record.day.startsWith(values[0] + '-')).sort((a, b) => a.day.localeCompare(b.day) || a.id - b.id), today: hongKongDay(now) });
      }
      if (now.toISOString() < state.updatedAt) fail('DEMO_CLOCK_ERROR', 409);
      const at = now.toISOString();
      if (exerciseWrite) {
        let result;
        if (method === 'POST') {
          const item = validateExercise(input);
          if (state.exercises.some((entry) => entry.type === item.type && entry.bodyPart === item.bodyPart && entry.name === item.name)) fail('EXERCISE_EXISTS', 409);
          result = { exercise: { id: state.nextId++, ...item, created_at: at } };
          state.exercises.push(result.exercise);
        } else if (method === 'PATCH') {
          fields(input, ['unit']);
          const entry = state.exercises.find((item) => item.id === Number(exerciseMatch[1]));
          if (!entry) fail('NOT_FOUND', 404);
          entry.unit = validUnit(input.unit, entry.type);
          result = { exercise: entry };
        } else {
          fields(input, []);
          const id = Number(exerciseMatch[1]);
          if (!state.exercises.some((entry) => entry.id === id)) fail('NOT_FOUND', 404);
          state.exercises = state.exercises.filter((entry) => entry.id !== id);
          result = { ok: true };
        }
        state.updatedAt = at;
        save(state);
        return copy(result);
      }
      let record;
      if (method === 'POST') {
        record = { ...validateRecord(input), id: state.nextId++, version: 1, created_at: at, updated_at: at };
        state.records.push(record);
      } else {
        const id = Number(match[1]);
        if (method === 'DELETE') { fields(input, ['version']); integer(input.version, 'VERSION', 2 ** 31 - 1); }
        const values = method === 'PATCH' ? validateRecord(input, true) : null;
        record = state.records.find((item) => item.id === id);
        if (!record) fail('NOT_FOUND', 404);
        if (record.version !== input.version) fail('RECORD_CHANGED', 409);
        if (method === 'DELETE') state.records = state.records.filter((item) => item.id !== id);
        else Object.assign(record, values, { version: record.version + 1, updated_at: at });
      }
      state.updatedAt = at;
      save(state);
      return method === 'DELETE' ? { ok: true } : { record: copy(record) };
    });
  }
  return { request, reset, refresh: () => serial((now) => ({ day: read(now).day })) };
}
