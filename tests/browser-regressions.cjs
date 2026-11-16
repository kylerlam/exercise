/* Uses an existing Playwright installation; never installs packages or browsers.
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node tests/browser-regressions.cjs
 * BROWSER_ENGINE=webkit WEBKIT_PATH=/path/to/pw_run.sh selects cached WebKit instead.
 * Optional EXERCISE_QA_OUTPUT=/tmp/exercise-qa retains screenshots. All data is temporary.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.BROWSER_ENGINE || 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine), 'BROWSER_ENGINE must be chromium or webkit');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'exercise-browser-'));
const output = process.env.EXERCISE_QA_OUTPUT;
if (output) fs.mkdirSync(output, { recursive: true });
let server, browser, base;
let checks = 0;
const errors = [];
const pass = (message) => console.log(`PASS ${++checks}: ${message}`);

async function launchServer() {
  server = spawn(process.env.PYTHON || 'python3', ['-B', 'backend/server.py'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: path.join(temporary, 'data'), DIST_DIR: path.join(root, 'dist') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Temporary server did not start.')), 10000);
    let text = '';
    server.stdout.on('data', (chunk) => {
      text += chunk;
      const match = text.match(/Exercise running at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    server.stderr.on('data', (chunk) => { text += chunk; });
    server.once('error', (error) => { clearTimeout(timer); reject(error); });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${text}`)); });
  });
}
async function api(context, method, endpoint, data) {
  const response = await context.request.fetch(base + endpoint, { method, ...(data ? { data } : {}) });
  assert.ok(response.ok(), `${method} ${endpoint}: ${response.status()} ${await response.text()}`);
  return response.json();
}
async function session(locale = 'en', width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Hong_Kong' });
  await context.addInitScript((value) => localStorage.setItem('exercise-locale', value), locale);
  await api(context, 'POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(base + '/#records');
  await page.waitForFunction(() => !document.querySelector('#new-record').disabled);
  await page.locator('#loading-state').waitFor({ state: 'hidden' });
  return { context, page };
}
async function snapshot(page, name) {
  if (output) await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
}
async function closeEntry(page) {
  await page.locator('#cancel-record').click();
  await page.locator('#record-dialog').waitFor({ state: 'hidden' });
}
async function checkFormBounds(page, description) {
  const geometry = await page.locator('#record-dialog').evaluate((dialog) => ({
    width: dialog.clientWidth,
    scroll: dialog.scrollWidth,
    labels: [...dialog.querySelectorAll('.field-label')].filter((label) => label.getBoundingClientRect().width > 0).map((label) => ({
      width: label.clientWidth,
      scroll: label.scrollWidth,
      left: label.getBoundingClientRect().left,
      right: label.getBoundingClientRect().right,
      fieldLeft: label.closest('.field').getBoundingClientRect().left,
      fieldRight: label.closest('.field').getBoundingClientRect().right,
    })),
  }));
  assert.ok(geometry.scroll <= geometry.width + 1, `${description} dialog overflows horizontally`);
  assert.ok(geometry.labels.every((label) => label.scroll <= label.width + 1 && label.left >= label.fieldLeft - 1 && label.right <= label.fieldRight + 1), `${description} field label overflows its column`);
}
async function fillStrength(page, exercise) {
  await page.locator('#add-strength').click();
  for (const [id, value] of [['entry-body', 'Legs'], ['entry-exercise', exercise], ['entry-sets', '3'], ['entry-reps', '12']]) await page.locator('#' + id).fill(value);
}
function nextDay(day) {
  const date = new Date(day + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

(async () => {
  base = await launchServer();
  const executable = engine === 'webkit' ? process.env.WEBKIT_PATH : process.env.CHROMIUM_PATH;
  browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
  const localeSource = fs.readFileSync(path.join(root, 'dist', 'i18n.mjs'), 'utf8') + '\nexport { en, cn, tw, es };';
  const dictionaries = await import('data:text/javascript;base64,' + Buffer.from(localeSource).toString('base64'));
  const sharedTerms = new Set(['cardio', 'minuteUnit', 'kmUnit', 'themes.aurora']);
  for (const [key, english] of Object.entries(dictionaries.en)) {
    assert.equal(typeof dictionaries.cn[key], 'string', `Missing Chinese translation: ${key}`);
    assert.equal(typeof dictionaries.tw[key], 'string', `Missing Traditional Chinese translation: ${key}`);
    assert.equal(typeof dictionaries.es[key], 'string', `Missing Spanish translation: ${key}`);
    if (!sharedTerms.has(key)) assert.notEqual(dictionaries.es[key], english, `Spanish falls back to English: ${key}`);
  }
  assert.equal(dictionaries.tw.nextDay, '後一天');
  assert.equal(dictionaries.tw.retry, '重試');
  assert.equal(dictionaries.tw['themes.white'], '純白');
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'es']) {
    for (const width of [320, 375, 390]) {
      const { context, page } = await session(locale, width);
      const nav = await page.locator('.navigation').evaluate((element) => [...element.querySelectorAll('.nav-item')].map((item) => {
        const text = item.lastElementChild;
        return { scroll: text.scrollWidth, width: text.clientWidth, right: text.getBoundingClientRect().right, boundary: item.getBoundingClientRect().right };
      }));
      assert.ok(nav.every((item) => item.scroll <= item.width + 1 && item.right <= item.boundary + 1), `${locale}/${width} navigation overflow`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.locator('#add-cardio').click();
      const tops = await page.locator('.cardio-fields input').evaluateAll((inputs) => inputs.map((input) => input.getBoundingClientRect().top));
      assert.ok(Math.max(...tops) - Math.min(...tops) <= 1, `${locale}/${width} cardio inputs: ${tops}`);
      const note = page.locator('#entry-notes').locator('..');
      assert.equal(await note.locator('.field-label .optional').count(), 1);
      const optional = await note.locator('.optional').boundingBox();
      const textarea = await page.locator('#entry-notes').boundingBox();
      assert.ok(optional.y + optional.height < textarea.y);
      await checkFormBounds(page, `${locale}/${width} cardio`);
      await snapshot(page, `cardio-${locale}-${width}`);
      await page.locator('#entry-type').selectOption('strength');
      const strength = await page.locator('.strength-fields input').evaluateAll((inputs) => inputs.map((input) => ({ x: input.getBoundingClientRect().x, y: input.getBoundingClientRect().y })));
      assert.ok(strength.every((item, index) => index === 0 || item.x > strength[index - 1].x));
      assert.ok(Math.max(...strength.map((item) => item.y)) - Math.min(...strength.map((item) => item.y)) <= 1);
      await page.locator('#entry-sets').fill('123');
      await page.locator('#entry-reps').fill('456');
      await checkFormBounds(page, `${locale}/${width} strength`);
      await snapshot(page, `strength-${locale}-${width}`);
      await closeEntry(page);
      await context.close();
    }
  }
  pass('Complete locale copy and 12 locale/width combinations: aligned inputs/labels, grouped Optional, wrapping nav, no form/document overflow');

  {
    const { context, page } = await session();
    await page.locator('[data-view="calendar"]').click();
    await page.locator('#calendar-view').waitFor({ state: 'visible' });
    const input = page.locator('#month-input');
    const native = await input.evaluate((element) => element.type === 'month');
    if (engine === 'webkit') assert.equal(native, false, 'Cached WebKit should exercise the real unsupported month-input path');
    const appearance = await input.evaluate((element) => ({ fallback: element.closest('.month-picker').classList.contains('is-fallback'), opacity: getComputedStyle(element).opacity, placeholder: element.placeholder, span: getComputedStyle(element.previousElementSibling).display, width: element.getBoundingClientRect().width, labelWidth: element.closest('.month-picker').getBoundingClientRect().width }));
    assert.equal(appearance.fallback, !native);
    assert.equal(appearance.opacity, native ? '0' : '1');
    if (!native) {
      assert.equal(appearance.placeholder, 'YYYY-MM');
      assert.equal(appearance.span, 'none');
      assert.ok(Math.abs(appearance.width - appearance.labelWidth) <= 1);
    }
    const original = await page.locator('#month-label').innerText();
    for (const invalid of ['2026-99', '2026-00', '1899-12', '9999-01']) {
      if (native) await input.evaluate((element, value) => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); }, invalid);
      else { await input.fill(invalid); await input.press('Enter'); }
      assert.equal(await page.locator('#month-label').innerText(), original);
      assert.ok(await input.evaluate((element) => element.validationMessage.length > 0), `${engine}: no validation feedback for ${invalid}`);
    }
    await input.fill('2028-02');
    await input.press(native ? 'Tab' : 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#calendar-grid .calendar-day:not(.outside)').length === 29);
    assert.equal(await input.inputValue(), '2028-02');
    await page.locator('[data-view="monthly"]').click();
    const monthly = page.locator('#monthly-month-input');
    await monthly.fill('2026-04');
    await monthly.press(native ? 'Tab' : 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#monthly-body tr').length === 30);
    assert.equal(await monthly.evaluate((element) => element.checkValidity()), true);
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
    await snapshot(page, `${engine}-month-picker-320`);
    await context.close();
  }
  pass('Native or visible text month pickers reject invalid months/year bounds and navigate real leap/30-day months');

  {
    const { context, page } = await session();
    const status = await api(context, 'GET', '/api/auth/status');
    const body = { day: status.today, type: 'strength', bodyPart: 'Legs', exercise: 'Conflict regression', sets: 3, reps: 12, duration: null, distance: null, notes: '' };
    let record = (await api(context, 'POST', '/api/records', body)).record;
    await page.reload();
    const edit = () => page.getByRole('button', { name: 'Edit record · Conflict regression', exact: true }).click();
    const remove = () => page.getByRole('button', { name: 'Delete record · Conflict regression', exact: true }).click();
    await edit();
    record = (await api(context, 'PATCH', '/api/records/' + record.id, { ...body, sets: 4, version: record.version })).record;
    await page.locator('#entry-sets').fill('5');
    await page.locator('#save-record').click();
    await page.locator('#record-error').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#save-record').disabled);
    assert.equal(await page.locator('#entry-sets').inputValue(), '5');
    await closeEntry(page);
    await edit();
    assert.equal(await page.locator('#entry-sets').inputValue(), '4');
    await page.locator('#entry-sets').fill('6');
    await page.locator('#save-record').click();
    await page.locator('#record-dialog').waitFor({ state: 'hidden' });
    await remove();
    record = (await api(context, 'GET', '/api/export')).records.find((row) => row.id === record.id);
    record = (await api(context, 'PATCH', '/api/records/' + record.id, { ...body, sets: 7, version: record.version })).record;
    await page.locator('#confirm-delete').click();
    await page.locator('#delete-error').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#keep-record').disabled);
    await page.locator('#keep-record').click();
    await remove();
    await page.locator('#confirm-delete').click();
    await page.locator('#delete-dialog').waitFor({ state: 'hidden' });
    assert.ok(!(await api(context, 'GET', '/api/export')).records.some((row) => row.id === record.id));
    await context.close();
  }
  pass('Save/delete conflicts refresh cached versions and preserve active drafts');

  {
    const { context, page } = await session();
    const status = await api(context, 'GET', '/api/auth/status');
    const tomorrow = nextDay(status.today);
    await page.route('**/api/auth/status', (route) => route.fulfill({ json: { ...status, today: tomorrow } }));
    await page.locator('#records-today').click();
    await page.waitForFunction((day) => document.querySelector('#record-date').value === day, tomorrow);
    await page.unroute('**/api/auth/status');
    await page.route('**/api/auth/status', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({ json: { ...status, today: status.today } });
    });
    await page.locator('#records-today').click();
    await page.locator('#next-day').click();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#record-date').inputValue(), nextDay(tomorrow));
    await context.close();
  }
  pass('Today reads the server date; delayed responses do not overwrite newer date navigation');

  {
    const { context, page } = await session();
    const status = await api(context, 'GET', '/api/auth/status');
    let releaseToday;
    let arrived;
    const responseGate = new Promise((resolve) => { releaseToday = resolve; });
    const requestArrived = new Promise((resolve) => { arrived = resolve; });
    await page.route('**/api/auth/status', async (route) => {
      arrived();
      await responseGate;
      await route.fulfill({ json: status });
    });
    await page.locator('#records-today').click();
    await requestArrived;
    await fillStrength(page, 'Late Today save');
    await page.locator('#entry-day').fill('2026-02-03');
    await page.locator('#save-record').click();
    await page.locator('#record-dialog').waitFor({ state: 'hidden' });
    await page.locator('#loading-state').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#record-date').inputValue(), '2026-02-03');
    releaseToday();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#record-date').inputValue(), '2026-02-03');
    const record = (await api(context, 'GET', '/api/export')).records.find((row) => row.exercise === 'Late Today save');
    await api(context, 'DELETE', '/api/records/' + record.id, { version: record.version });
    await context.close();
  }
  pass('A Today response held through a successful save cannot replace the saved record date');

  {
    const { context, page } = await session();
    await fillStrength(page, 'Recovered draft');
    await page.locator('#entry-notes').fill('Keep my unfinished workout');
    await api(context, 'POST', '/api/auth/logout', {});
    await page.locator('#save-record').click();
    await page.waitForURL('**/login.html');
    await page.locator('#login-username').fill('admin');
    await page.locator('#login-password').fill('admin123');
    await page.locator('#sign-in').click();
    await page.locator('#record-dialog').waitFor({ state: 'visible' });
    for (const [id, value] of [['entry-body', 'Legs'], ['entry-exercise', 'Recovered draft'], ['entry-sets', '3'], ['entry-reps', '12'], ['entry-notes', 'Keep my unfinished workout']]) assert.equal(await page.locator('#' + id).inputValue(), value);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('exercise-pending-record')), null);
    await page.locator('#save-record').click();
    await page.locator('#record-dialog').waitFor({ state: 'hidden' });
    const saved = (await api(context, 'GET', '/api/export')).records.filter((row) => row.exercise === 'Recovered draft');
    assert.equal(saved.length, 1);
    await api(context, 'DELETE', '/api/records/' + saved[0].id, { version: saved[0].version });
    await page.evaluate(() => sessionStorage.setItem('exercise-pending-record', JSON.stringify({ values: { exercise: 'clear on logout' } })));
    await page.locator('#open-settings').click();
    await page.locator('#sign-out').click();
    await page.waitForURL('**/login.html');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('exercise-pending-record')), null);
    await context.close();
  }
  pass('Expired-session sign-in restores once; save creates one record; explicit logout clears drafts');

  for (const expiresDuringLoad of [false, true]) {
    const { context, page } = await session();
    const draft = { editing: null, values: { day: '2026-02-03', type: 'strength', bodyPart: 'Legs', exercise: 'Other-month draft', sets: '4', reps: '15', duration: '', distance: '', notes: 'Original recovered notes' } };
    await page.evaluate((value) => sessionStorage.setItem('exercise-pending-record', JSON.stringify(value)), draft);
    let release;
    let arrived;
    const responseGate = new Promise((resolve) => { release = resolve; });
    const requestArrived = new Promise((resolve) => { arrived = resolve; });
    const pattern = '**/api/records?month=2026-02';
    await page.route(pattern, async (route) => {
      arrived();
      await responseGate;
      if (expiresDuringLoad) await route.fulfill({ status: 401, json: { error: 'Sign in to continue.', code: 'AUTH_REQUIRED' } });
      else await route.continue();
    });
    await page.reload({ waitUntil: 'commit' });
    await requestArrived;
    await page.locator('#record-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#entry-exercise').inputValue(), 'Other-month draft');
    await page.locator('#entry-notes').fill('Edited while month request was pending');
    const backgroundAdd = await page.locator('#new-record').boundingBox();
    await page.mouse.click(backgroundAdd.x + backgroundAdd.width / 2, backgroundAdd.y + backgroundAdd.height / 2);
    assert.equal(await page.locator('#entry-notes').inputValue(), 'Edited while month request was pending');
    if (expiresDuringLoad) await api(context, 'POST', '/api/auth/logout', {});
    release();
    if (expiresDuringLoad) {
      await page.waitForURL('**/login.html');
      const preserved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('exercise-pending-record')));
      assert.equal(preserved.values.notes, 'Edited while month request was pending');
      await page.unroute(pattern);
      await page.locator('#login-username').fill('admin');
      await page.locator('#login-password').fill('admin123');
      await page.locator('#sign-in').click();
      await page.locator('#record-dialog').waitFor({ state: 'visible' });
    }
    await page.locator('#loading-state').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#entry-notes').inputValue(), 'Edited while month request was pending');
    assert.equal(await page.locator('#entry-day').inputValue(), '2026-02-03');
    await closeEntry(page);
    await context.close();
  }
  pass('Other-month recovery opens before loading, keeps new edits, and preserves the consumed draft if authentication fails');

  {
    const { context, page } = await session();
    await fillStrength(page, 'Blocked-storage draft');
    await page.evaluate(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (this === window.sessionStorage) throw new DOMException('Storage blocked', 'SecurityError');
        return setItem.call(this, key, value);
      };
    });
    await api(context, 'POST', '/api/auth/logout', {});
    await page.locator('#save-record').click();
    await page.locator('#record-reauth').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#record-dialog').evaluate((dialog) => dialog.open), true);
    assert.equal(await page.locator('#entry-exercise').inputValue(), 'Blocked-storage draft');
    assert.equal(await page.locator('#record-reauth').getAttribute('target'), '_blank');
    await api(context, 'POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    await page.locator('#save-record').click();
    await page.locator('#record-dialog').waitFor({ state: 'hidden' });
    const record = (await api(context, 'GET', '/api/export')).records.find((row) => row.exercise === 'Blocked-storage draft');
    assert.ok(record);
    await api(context, 'DELETE', '/api/records/' + record.id, { version: record.version });
    await context.close();
  }
  pass('Blocked session storage retains the draft and allows retry after another-tab sign-in');

  {
    const { context, page } = await session('en', 320);
    await page.locator('#add-cardio').click();
    await page.locator('#entry-cardio-exercise').fill('Running');
    await page.locator('#entry-duration').fill('30.5');
    await page.locator('#entry-type').selectOption('strength');
    await page.locator('#entry-body').fill('Legs');
    await page.locator('#entry-exercise').fill('Squat');
    await page.locator('#entry-sets').fill('4');
    await page.locator('#entry-reps').fill('15');
    await page.locator('#entry-type').selectOption('cardio');
    assert.equal(await page.locator('#entry-cardio-exercise').inputValue(), 'Running');
    assert.equal(await page.locator('#entry-duration').inputValue(), '30.5');
    await page.setViewportSize({ width: 320, height: 568 });
    await page.locator('#entry-notes').focus();
    await page.locator('#save-record').scrollIntoViewIfNeeded();
    const button = await page.locator('#save-record').boundingBox();
    assert.ok(button.y >= 0 && button.y + button.height <= 568);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
    await snapshot(page, 'short-viewport-cardio-320');
    await closeEntry(page);
    await context.close();
  }
  pass('Type switches retain entered values; short mobile viewports keep save controls reachable');
  assert.deepEqual(errors, []);
  pass('No uncaught browser errors');
  console.log(`Browser regressions complete: ${checks} groups passed; data was isolated.`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  }
  fs.rmSync(temporary, { recursive: true, force: true });
});
