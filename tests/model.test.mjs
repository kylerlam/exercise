import test from 'node:test';
import assert from 'node:assert/strict';
import { monthDays, calendarDays, shiftDay, shiftMonth, summarize, positiveInteger, recordPayload, validMonth } from '../dist/model.mjs';

test('month navigation accepts only real months within supported year bounds', () => {
  for (const month of ['1900-01', '2026-02', '2026-12', '9998-12']) assert.equal(validMonth(month), true);
  for (const month of ['2026-00', '2026-13', '2026-99', '2026-2', '2026-02-01', '1899-12', '9999-01', '', null, 202611]) assert.equal(validMonth(month), false, String(month));
});

test('monthly rows match real calendar months, including leap century rules', () => {
  for (const [month, count] of [['2026-02', 28], ['2028-02', 29], ['1900-02', 28], ['2000-02', 29], ['2026-04', 30], ['2026-12', 31], ['9998-12', 31]]) {
    const days = monthDays(month);
    assert.equal(days.length, count);
    assert.equal(days[0], month + '-01');
    assert.equal(days.at(-1), month + '-' + String(count).padStart(2, '0'));
    assert.equal(new Set(days).size, count);
  }
});

test('date navigation crosses month and year boundaries correctly', () => {
  assert.equal(shiftDay('2028-03-01', -1), '2028-02-29');
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
});

test('Monday-first calendar contains every date exactly once', () => {
  for (const month of ['2026-02', '2026-11', '2028-02', '9998-12']) {
    const calendar = calendarDays(month);
    assert.equal(calendar.length % 7, 0);
    assert.equal(new Date(calendar[0] + 'T12:00:00').getDay(), 1);
    assert.deepEqual(calendar.filter(day => day.startsWith(month)), monthDays(month));
  }
});

test('monthly totals count distinct days and all performed repetitions', () => {
  const rows = [
    { day: '2026-11-16', type: 'strength', sets: 4, reps: 15 },
    { day: '2026-11-16', type: 'strength', sets: 3, reps: 12 },
    { day: '2026-11-16', type: 'cardio', duration: 30.5, distance: 5 },
    { day: '2026-11-17', type: 'cardio', duration: 20, distance: null },
  ];
  assert.deepEqual(summarize(rows), { days: 2, sets: 7, reps: 96, duration: 50.5, distance: 5 });
  assert.deepEqual(summarize([]), { days: 0, sets: 0, reps: 0, duration: 0, distance: 0 });
});

test('sets and reps accept only positive whole-number input within the limit', () => {
  for (const value of ['1', '4', '15', '10000']) assert.equal(positiveInteger(value), true);
  for (const value of ['', '0', '-1', '1.5', '1.0', '1e2', 'NaN', 'Infinity', '1x', '10001']) {
    assert.equal(positiveInteger(value), false, value);
  }
});

test('payloads preserve numeric JSON types and clear fields from the other training type', () => {
  const values = { day: '2026-11-16', type: 'strength', bodyPart: ' 腿 ', exercise: ' 深蹲 ', sets: '4', reps: '15', weight: '60', duration: '30.5', distance: '', notes: ' 今天 ' };
  assert.deepEqual(recordPayload(values), { day: '2026-11-16', type: 'strength', bodyPart: '腿', exercise: '深蹲', sets: 4, reps: 15, weight: 60, duration: null, distance: null, notes: '今天' });
  assert.deepEqual(recordPayload({ ...values, weight: '' }), { day: '2026-11-16', type: 'strength', bodyPart: '腿', exercise: '深蹲', sets: 4, reps: 15, weight: null, duration: null, distance: null, notes: '今天' });
  assert.deepEqual(recordPayload({ ...values, type: 'cardio' }), { day: '2026-11-16', type: 'cardio', bodyPart: '', exercise: '深蹲', sets: null, reps: null, weight: null, duration: 30.5, distance: null, notes: '今天' });
});
