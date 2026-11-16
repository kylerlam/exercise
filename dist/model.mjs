export function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function dateValue(day) {
  return new Date(day + 'T12:00:00');
}

export function shiftDay(day, offset) {
  const value = dateValue(day);
  value.setDate(value.getDate() + offset);
  return localDay(value);
}

export function shiftMonth(month, offset) {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(year, number - 1 + offset, 1, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function monthDays(month) {
  const [year, number] = month.split('-').map(Number);
  const count = new Date(year, number, 0).getDate();
  return Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
}

export function calendarDays(month) {
  const first = month + '-01';
  const offset = (dateValue(first).getDay() + 6) % 7;
  const length = Math.ceil((offset + monthDays(month).length) / 7) * 7;
  return Array.from({ length }, (_, index) => shiftDay(first, index - offset));
}

export function summarize(records) {
  const strength = records.filter((record) => record.type === 'strength');
  const cardio = records.filter((record) => record.type === 'cardio');
  return {
    days: new Set(records.map((record) => record.day)).size,
    sets: strength.reduce((sum, row) => sum + row.sets, 0),
    reps: strength.reduce((sum, row) => sum + row.sets * row.reps, 0),
    duration: cardio.reduce((sum, row) => sum + row.duration, 0),
    distance: cardio.reduce((sum, row) => sum + (row.distance ?? 0), 0),
  };
}

export function positiveInteger(value) {
  return /^[1-9]\d*$/.test(value) && Number(value) <= 10000;
}

export function recordPayload(values) {
  const strength = values.type === 'strength';
  return {
    day: values.day,
    type: values.type,
    bodyPart: strength ? values.bodyPart.trim() : '',
    exercise: values.exercise.trim(),
    sets: strength ? Number(values.sets) : null,
    reps: strength ? Number(values.reps) : null,
    duration: strength ? null : Number(values.duration),
    distance: strength || values.distance === '' ? null : Number(values.distance),
    notes: values.notes.trim(),
  };
}
