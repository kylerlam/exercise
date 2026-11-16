import { applyTranslations, getLocale, t } from './i18n.mjs';
import { applyTheme } from './theme.mjs';
import { initSettings } from './settings.mjs';
import { authRequest, errorMessage, redirectToLogin, saveRecordDraft, takeRecordDraft } from './auth.mjs';
import { calendarDays, dateValue, localDay, monthDays, positiveInteger, recordPayload, shiftDay, shiftMonth, summarize, validMonth } from './model.mjs';

const $ = (selector) => document.querySelector(selector);
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="m14 6-6 6 6 6"/>',
  right: '<path d="m10 6 6 6-6 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  chart: '<path d="M4 4v16h16M8 15v-4M13 15V7M18 15v-7"/>',
  export: '<path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"/>',
  settings: '<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15l-1 5Z"/>',
  delete: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/>',
  strength: '<path d="m8 8 8 8M4 8l4-4 4 4-4 4Zm8 8 4-4 4 4-4 4M2 12l4-4m12 12 4-4"/>',
};
function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.strength}</svg>`;
}
for (const element of document.querySelectorAll('[data-icon]')) element.innerHTML = icon(element.dataset.icon);

let today = localDay();
let selectedDay = today;
let month = today.slice(0, 7);
let records = [];
let loadedMonth = null;
let view = 'calendar';
let requestVersion = 0;
let selectionVersion = 0;
let authenticated = false;
let loading = true;
let toastTimer;
const recordDialog = $('#record-dialog');
const recordForm = $('#record-form');
let editing = null;
let entryBusy = false;
let draftBaseline = '';
let deleting = null;
let deleteBusy = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function number(value) {
  return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 3 }).format(value);
}
function dayLabel(day, options = { month: 'long', day: 'numeric', weekday: 'long' }) {
  return new Intl.DateTimeFormat(getLocale(), options).format(dateValue(day));
}
function monthLabel() {
  return dayLabel(month + '-01', { year: 'numeric', month: 'long' });
}
function dayRecords(day = selectedDay) {
  if (loadedMonth !== month) return [];
  return records.filter((record) => record.day === day);
}
function compactDescription(record) {
  if (record.type === 'strength') return `${record.bodyPart}：${record.exercise} × ${record.sets} × ${record.reps}`;
  return `${record.exercise} · ${number(record.duration)} ${t('minuteUnit')}${record.distance === null ? '' : ` · ${number(record.distance)} ${t('kmUnit')}`}`;
}
function showToast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}
function showPageError(error) {
  $('#page-error span').textContent = errorMessage(error);
  $('#page-error').hidden = false;
}
function handleAuthError(error) {
  if (error.status === 401) {
    if (isDirty()) {
      const draft = { values: entryValues(), editing: editing ? { id: editing.id, version: editing.version } : null };
      if (!saveRecordDraft(draft)) {
        $('#record-error').textContent = t('sessionExpiredDraftRetained');
        $('#record-error').hidden = false;
        $('#record-reauth').hidden = false;
        return true;
      }
      draftBaseline = JSON.stringify(entryValues());
    }
    redirectToLogin();
    return true;
  }
  return false;
}
function validDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= '1900-01-01' && day <= '9998-12-31' && !Number.isNaN(dateValue(day).getTime());
}
async function loadMonth() {
  const version = ++requestVersion;
  const requestedMonth = month;
  loading = true;
  $('#page-error').hidden = true;
  render();
  try {
    const result = await authRequest(`/api/records?month=${encodeURIComponent(requestedMonth)}`);
    if (version !== requestVersion) return;
    records = result.records;
    if (result.today) today = result.today;
    loadedMonth = requestedMonth;
  } catch (error) {
    if (version !== requestVersion || handleAuthError(error)) return;
    showPageError(error);
  } finally {
    if (version === requestVersion) {
      loading = false;
      render();
    }
  }
}
function selectDay(day, targetView = view) {
  if (!validDay(day)) return;
  selectionVersion++;
  selectedDay = day;
  const nextMonth = day.slice(0, 7);
  month = nextMonth;
  if (targetView !== view) location.hash = targetView;
  if (loadedMonth !== month || loading) loadMonth();
  else render();
}
function changeMonth(next) {
  if (!validMonth(next)) return;
  selectionVersion++;
  if (next === month && (loading || loadedMonth === month)) return;
  month = next;
  selectedDay = today.startsWith(next) ? today : next + '-01';
  loadMonth();
}
function applyMonthInput(input) {
  if (!validMonth(input.value)) {
    input.setCustomValidity(t('invalidMonth'));
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  changeMonth(input.value);
}
async function selectToday() {
  const version = ++selectionVersion;
  try {
    const status = await authRequest('/api/auth/status');
    if (version !== selectionVersion) return;
    if (!status.authenticated) { handleAuthError({ status: 401 }); return; }
    today = status.today || today;
    selectDay(today);
  } catch (error) {
    if (version === selectionVersion && !handleAuthError(error)) showPageError(error);
  }
}
function actionButton(name, label, callback) {
  const button = element('button', 'icon-button record-action');
  button.type = 'button';
  button.innerHTML = icon(name);
  button.setAttribute('aria-label', label);
  button.title = label;
  button.addEventListener('click', callback);
  return button;
}
function recordActions(record) {
  const actions = element('div', 'record-actions');
  actions.append(
    actionButton('edit', `${t('editRecord')} · ${record.exercise}`, () => openRecord(record)),
    actionButton('delete', `${t('deleteRecord')} · ${record.exercise}`, () => openDelete(record)),
  );
  return actions;
}
function emptyState(target, full = false) {
  const empty = element('div', 'empty-state' + (full ? '' : ' small-empty'));
  empty.innerHTML = icon('strength');
  empty.append(element('h3', '', t(full ? 'emptyDay' : 'noRecords')));
  if (full) {
    empty.append(element('p', '', t('emptyDayHint')));
    const button = element('button', 'button', t('newRecord'));
    button.type = 'button';
    button.addEventListener('click', () => openRecord());
    empty.append(button);
  }
  target.append(empty);
}
function renderCalendar() {
  $('#month-label').textContent = monthLabel();
  $('#month-input').value = month;
  $('#month-input').setCustomValidity('');
  $('#previous-month').disabled = month === '1900-01';
  $('#next-month').disabled = month === '9998-12';
  $('#weekdays').replaceChildren(...Array.from({ length: 7 }, (_, index) => element('span', '', dayLabel(`2026-11-${String(index + 2).padStart(2, '0')}`, { weekday: 'narrow' }))));
  const grid = $('#calendar-grid');
  grid.replaceChildren();
  for (const day of calendarDays(month)) {
    const items = dayRecords(day);
    const button = element('button', 'calendar-day');
    button.type = 'button';
    button.classList.toggle('outside', !day.startsWith(month));
    button.classList.toggle('is-today', day === today);
    button.classList.toggle('selected', day === selectedDay);
    button.disabled = !validDay(day);
    button.setAttribute('aria-pressed', String(day === selectedDay));
    button.setAttribute('aria-label', dayLabel(day, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }) + ' · ' + (items.length ? items.map(compactDescription).join('；') : t('noRecords')));
    if (day === today) button.setAttribute('aria-current', 'date');
    button.title = items.map(compactDescription).join('\n');
    button.append(element('span', 'day-number', String(Number(day.slice(-2)))));
    const indicators = element('span', 'day-indicators');
    if (items.some((row) => row.type === 'strength')) indicators.append(element('i', 'activity-dot strength-dot'));
    if (items.some((row) => row.type === 'cardio')) indicators.append(element('i', 'activity-dot cardio-dot'));
    button.append(indicators);
    const summary = element('span', 'calendar-workout', items.length ? items[0].exercise + (items.length > 1 ? ` +${items.length - 1}` : '') : '');
    summary.setAttribute('aria-hidden', 'true');
    button.append(summary);
    button.addEventListener('click', () => selectDay(day));
    grid.append(button);
  }
  $('#day-title').textContent = dayLabel(selectedDay);
  const rows = dayRecords();
  const strength = rows.filter((row) => row.type === 'strength').length;
  const cardio = rows.length - strength;
  $('#day-summary').textContent = rows.length ? [strength ? t('strengthCount', { count: strength }) : '', cardio ? t('cardioCount', { count: cardio }) : ''].filter(Boolean).join(' · ') : t('noRecords');
  const list = $('#day-list');
  list.replaceChildren();
  if (!rows.length) emptyState(list, true);
  for (const record of rows) {
    const row = element('article', 'task-row workout-row');
    const type = element('span', 'record-type-icon ' + record.type);
    type.innerHTML = icon(record.type === 'strength' ? 'strength' : 'chart');
    type.title = t(record.type);
    const copy = element('div', 'task-copy');
    copy.append(element('p', 'task-title', compactDescription(record)));
    if (record.notes) copy.append(element('p', 'task-notes', record.notes));
    row.append(type, copy, recordActions(record));
    list.append(row);
  }
}
function renderRecordTable(target, rows, type) {
  target.replaceChildren();
  if (!rows.length) { emptyState(target); return; }
  const scroll = element('div', 'record-table-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('aria-label', t(type));
  const table = element('table', 'record-table ' + type + '-table');
  const head = element('thead');
  const header = element('tr');
  const keys = type === 'strength' ? ['bodyPart', 'exercise', 'sets', 'reps'] : ['exercise', 'duration', 'distance'];
  for (const key of keys) {
    const th = element('th', '', t(key));
    th.scope = 'col';
    if (key === 'reps') th.title = t('perSet');
    header.append(th);
  }
  const actionsHeading = element('th');
  actionsHeading.scope = 'col';
  actionsHeading.append(element('span', 'sr-only', t('editRecord')));
  header.append(actionsHeading);
  head.append(header);
  table.append(head);
  const body = element('tbody');
  for (const record of rows) {
    const row = element('tr');
    for (const key of keys) {
      const cell = element('td', ['sets', 'reps', 'duration', 'distance'].includes(key) ? 'numeric-cell' : '');
      const value = record[key];
      cell.append(element('span', '', value === null ? '—' : typeof value === 'number' ? number(value) : value));
      if (key === 'exercise' && record.notes) cell.append(element('p', 'table-notes', record.notes));
      row.append(cell);
    }
    const actionsCell = element('td');
    actionsCell.append(recordActions(record));
    row.append(actionsCell);
    body.append(row);
  }
  table.append(body);
  scroll.append(table);
  target.append(scroll);
}
function renderRecords() {
  $('#record-date').value = selectedDay;
  $('#previous-day').disabled = selectedDay === '1900-01-01';
  $('#next-day').disabled = selectedDay === '9998-12-31';
  const rows = dayRecords();
  renderRecordTable($('#strength-list'), rows.filter((row) => row.type === 'strength'), 'strength');
  renderRecordTable($('#cardio-list'), rows.filter((row) => row.type === 'cardio'), 'cardio');
}
function renderMonthly() {
  $('#monthly-month-label').textContent = monthLabel();
  $('#monthly-month-input').value = month;
  $('#monthly-month-input').setCustomValidity('');
  $('#monthly-previous').disabled = month === '1900-01';
  $('#monthly-next').disabled = month === '9998-12';
  const totals = summarize(loadedMonth === month ? records : []);
  const stats = $('#month-stats');
  stats.replaceChildren();
  for (const [label, value] of [['trainingDays', totals.days], ['totalSets', totals.sets], ['totalReps', totals.reps], ['cardioMinutes', totals.duration]]) {
    const stat = element('div', 'panel summary-stat');
    stat.append(element('span', '', t(label)), element('strong', '', number(value)));
    stats.append(stat);
  }
  const body = $('#monthly-body');
  body.replaceChildren();
  for (const day of monthDays(month)) {
    const row = element('tr');
    row.classList.toggle('today-row', day === today);
    const dateCell = element('th');
    dateCell.scope = 'row';
    const date = element('button', 'month-day-link');
    date.type = 'button';
    date.append(element('strong', '', day.slice(5).replace('-', '/')), element('span', '', dayLabel(day, { weekday: 'short' })));
    date.setAttribute('aria-label', dayLabel(day) + ' · ' + t('records'));
    date.addEventListener('click', () => selectDay(day, 'records'));
    dateCell.append(date);
    const content = element('td');
    const rows = dayRecords(day);
    if (!rows.length) content.append(element('span', 'month-empty', t('monthEmpty')));
    for (const record of rows) {
      const entry = element('div', 'monthly-record');
      const indicator = element('i', 'activity-dot ' + record.type + '-dot');
      indicator.title = t(record.type);
      const copy = element('div');
      copy.append(element('p', '', compactDescription(record)));
      if (record.notes) copy.append(element('p', 'table-notes', record.notes));
      entry.append(indicator, copy, recordActions(record));
      content.append(entry);
    }
    row.append(dateCell, content);
    body.append(row);
  }
}
function render() {
  $('#page-title').textContent = t(view === 'records' ? 'records' : view === 'monthly' ? 'monthly' : 'calendar');
  $('#page-subtitle').textContent = t(view + 'Subtitle');
  $('#loading-state').hidden = !loading;
  for (const name of ['calendar', 'records', 'monthly']) {
    $('#' + name + '-view').hidden = name !== view || !authenticated;
    $('#' + name + '-view').setAttribute('aria-busy', String(loading));
    document.querySelector(`[data-view="${name}"]`).classList.toggle('active', name === view);
    document.querySelector(`[data-view="${name}"]`).setAttribute('aria-current', name === view ? 'page' : 'false');
  }
  $('#new-record').disabled = !authenticated;
  if (!authenticated) return;
  if (view === 'calendar') renderCalendar();
  if (view === 'records') renderRecords();
  if (view === 'monthly') renderMonthly();
}
function route() {
  const name = location.hash.slice(1);
  view = ['records', 'calendar', 'monthly'].includes(name) ? name : 'calendar';
  render();
}
function entryValues() {
  const type = $('#entry-type').value;
  return {
    day: $('#entry-day').value,
    type,
    bodyPart: $('#entry-body').value,
    exercise: $(type === 'strength' ? '#entry-exercise' : '#entry-cardio-exercise').value,
    sets: $('#entry-sets').value,
    reps: $('#entry-reps').value,
    duration: $('#entry-duration').value,
    distance: $('#entry-distance').value,
    notes: $('#entry-notes').value,
  };
}
function isDirty() {
  return recordDialog.open && JSON.stringify(entryValues()) !== draftBaseline;
}
function syncTypeFields() {
  const strength = $('#entry-type').value === 'strength';
  $('#strength-fields').hidden = !strength;
  $('#cardio-fields').hidden = strength;
  for (const input of $('#strength-fields').querySelectorAll('input')) { input.disabled = !strength; input.required = strength; }
  for (const input of $('#cardio-fields').querySelectorAll('input')) { input.disabled = strength; input.required = !strength && input.id !== 'entry-distance'; }
}
function openRecord(record = null, type = 'strength') {
  if (!authenticated) return;
  editing = record;
  recordForm.reset();
  $('#entry-type').value = record?.type || type;
  $('#entry-day').value = record?.day || selectedDay;
  $('#entry-body').value = record?.bodyPart || '';
  $('#entry-exercise').value = record?.type === 'strength' ? record.exercise : '';
  $('#entry-cardio-exercise').value = record?.type === 'cardio' ? record.exercise : '';
  $('#entry-sets').value = record?.sets ?? '';
  $('#entry-reps').value = record?.reps ?? '';
  $('#entry-duration').value = record?.duration ?? '';
  $('#entry-distance').value = record?.distance ?? '';
  $('#entry-notes').value = record?.notes || '';
  $('#record-dialog-title').textContent = t(record ? 'editRecord' : 'newRecord');
  $('#record-error').hidden = true;
  $('#record-reauth').hidden = true;
  syncTypeFields();
  draftBaseline = JSON.stringify(entryValues());
  recordDialog.showModal();
  $(($('#entry-type').value === 'strength') ? '#entry-body' : '#entry-cardio-exercise').focus();
}
function closeRecord() {
  if (!entryBusy && (!isDirty() || confirm(t('discardDraft')))) recordDialog.close();
}
async function restoreRecordDraft() {
  const draft = takeRecordDraft();
  if (!draft || !validDay(draft.values.day) || !['strength', 'cardio'].includes(draft.values.type)) return false;
  const values = draft.values;
  selectionVersion++;
  selectedDay = values.day;
  month = values.day.slice(0, 7);
  openRecord(draft.editing ? { ...values, ...draft.editing } : null, values.type);
  for (const [key, id] of Object.entries({ day: 'entry-day', bodyPart: 'entry-body', sets: 'entry-sets', reps: 'entry-reps', duration: 'entry-duration', distance: 'entry-distance', notes: 'entry-notes' })) {
    $('#' + id).value = values[key] ?? '';
  }
  $(values.type === 'strength' ? '#entry-exercise' : '#entry-cardio-exercise').value = values.exercise ?? '';
  draftBaseline = '';
  showToast(t('draftRestored'));
  if (loadedMonth !== month) await loadMonth();
  else render();
  return true;
}
function setEntryBusy(value) {
  entryBusy = value;
  for (const input of recordForm.querySelectorAll('input, textarea')) input.readOnly = value;
  $('#entry-type').disabled = value;
  for (const button of recordForm.querySelectorAll('button')) button.disabled = value;
  $('#save-record').textContent = t(value ? 'saving' : 'saveRecord');
}
recordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (entryBusy) return;
  const values = entryValues();
  let validation;
  if (values.type === 'strength' && (!positiveInteger(values.sets) || !positiveInteger(values.reps))) validation = 'integerError';
  if (values.type === 'cardio' && !(Number(values.duration) > 0 && Number.isFinite(Number(values.duration)) && Number(values.duration) <= 10080)) validation = 'durationError';
  if (values.type === 'cardio' && values.distance !== '' && !(Number(values.distance) > 0 && Number.isFinite(Number(values.distance)) && Number(values.distance) <= 100000)) validation = 'distanceError';
  $('#record-error').hidden = !validation;
  $('#record-reauth').hidden = true;
  if (validation) { $('#record-error').textContent = t(validation); return; }
  const body = recordPayload(values);
  if (editing) body.version = editing.version;
  setEntryBusy(true);
  try {
    const result = await authRequest(editing ? `/api/records/${editing.id}` : '/api/records', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    draftBaseline = JSON.stringify(entryValues());
    recordDialog.close();
    selectionVersion++;
    selectedDay = result.record.day;
    month = selectedDay.slice(0, 7);
    await loadMonth();
    showToast(t('saved'));
  } catch (error) {
    if (handleAuthError(error)) return;
    $('#record-error').textContent = error.status === 409 ? t('staleRecord') : errorMessage(error);
    $('#record-error').hidden = false;
    if (error.status === 409) await loadMonth();
  } finally { setEntryBusy(false); }
});
$('#entry-type').addEventListener('change', syncTypeFields);
$('#close-record').addEventListener('click', closeRecord);
$('#cancel-record').addEventListener('click', closeRecord);
recordDialog.addEventListener('cancel', (event) => { event.preventDefault(); closeRecord(); });
window.addEventListener('beforeunload', (event) => {
  if (isDirty()) { event.preventDefault(); event.returnValue = ''; }
});
function openDelete(record) {
  deleting = record;
  $('#delete-record-name').textContent = compactDescription(record);
  $('#delete-error').hidden = true;
  $('#delete-dialog').showModal();
}
$('#keep-record').addEventListener('click', () => { if (!deleteBusy) $('#delete-dialog').close(); });
$('#delete-dialog').addEventListener('cancel', (event) => { if (deleteBusy) event.preventDefault(); });
$('#confirm-delete').addEventListener('click', async () => {
  if (deleteBusy || !deleting) return;
  deleteBusy = true;
  $('#confirm-delete').disabled = $('#keep-record').disabled = true;
  try {
    await authRequest(`/api/records/${deleting.id}`, { method: 'DELETE', body: JSON.stringify({ version: deleting.version }) });
    $('#delete-dialog').close();
    await loadMonth();
    showToast(t('deleted'));
  } catch (error) {
    if (handleAuthError(error)) return;
    $('#delete-error').textContent = error.status === 409 ? t('errors.CONFLICT') : errorMessage(error);
    $('#delete-error').hidden = false;
    if (error.status === 409) await loadMonth();
  } finally {
    deleteBusy = false;
    $('#confirm-delete').disabled = $('#keep-record').disabled = false;
  }
});
for (const id of ['#new-record', '#day-add']) $(id).addEventListener('click', () => openRecord());
$('#add-strength').addEventListener('click', () => openRecord(null, 'strength'));
$('#add-cardio').addEventListener('click', () => openRecord(null, 'cardio'));
$('#record-date').addEventListener('change', (event) => selectDay(event.target.value));
$('#previous-day').addEventListener('click', () => selectDay(shiftDay(selectedDay, -1)));
$('#next-day').addEventListener('click', () => selectDay(shiftDay(selectedDay, 1)));
for (const id of ['#month-input', '#monthly-month-input']) {
  const input = $(id);
  if (input.type !== 'month') {
    input.closest('.month-picker').classList.add('is-fallback');
    input.placeholder = 'YYYY-MM';
    input.pattern = '[0-9]{4}-(0[1-9]|1[0-2])';
    input.maxLength = 7;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.enterKeyHint = 'go';
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); applyMonthInput(input); }
    });
  }
  input.addEventListener('input', () => input.setCustomValidity(''));
  input.addEventListener('change', () => applyMonthInput(input));
}
for (const id of ['#previous-month', '#monthly-previous']) $(id).addEventListener('click', () => changeMonth(shiftMonth(month, -1)));
for (const id of ['#next-month', '#monthly-next']) $(id).addEventListener('click', () => changeMonth(shiftMonth(month, 1)));
for (const id of ['#calendar-today', '#records-today', '#monthly-today']) $(id).addEventListener('click', selectToday);
$('#retry-load').addEventListener('click', () => { if (authenticated) loadMonth(); else location.reload(); });
let exporting = false;
async function exportData() {
  if (exporting) return;
  exporting = true;
  try {
    const data = await authRequest('/api/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
    const link = element('a');
    link.href = url;
    link.download = `exercise-${today}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(t('exported'));
  } catch (error) {
    if (!handleAuthError(error)) showToast(t('exportFailed'), true);
  } finally { exporting = false; }
}
$('#open-export').addEventListener('click', exportData);
$('#mobile-export').addEventListener('click', exportData);
window.addEventListener('hashchange', route);
window.addEventListener('localechange', () => {
  applyTranslations();
  $('#record-dialog-title').textContent = t(editing ? 'editRecord' : 'newRecord');
  render();
});
document.addEventListener('visibilitychange', () => {
  const fieldFocused = document.activeElement?.matches('input, textarea, select');
  if (document.visibilityState === 'visible' && authenticated && !fieldFocused && !recordDialog.open && !$('#delete-dialog').open && !$('#settings-dialog')?.open && !loading) loadMonth();
});
applyTheme();
applyTranslations();
route();
try {
  const status = await authRequest('/api/auth/status');
  if (!status.authenticated) redirectToLogin();
  else {
    authenticated = true;
    today = status.today || today;
    selectionVersion++;
    selectedDay = today;
    month = today.slice(0, 7);
    initSettings(status.user);
    if (!await restoreRecordDraft()) await loadMonth();
  }
} catch (error) {
  loading = false;
  showPageError(error);
  render();
}
