import { applyTranslations, getLocale, setLocale, t } from './i18n.mjs';
import { THEMES, getTheme, setTheme, applyTheme } from './theme.mjs';
import { authRequest, errorMessage, redirectToLogin } from './auth.mjs';
import { initPasswordFields } from './password-field.mjs';

export function initSettings(user = null) {
  applyTheme();
  const dialog = document.createElement('dialog');
  dialog.id = 'settings-dialog';
  dialog.className = 'settings-dialog';
  dialog.setAttribute('aria-labelledby', 'settings-title');
  dialog.innerHTML = `
    <div class="dialog-heading">
      <h2 id="settings-title"><span data-i18n="settings"></span> <code class="settings-version">v0.1.0</code></h2>
      <button class="icon-button" id="close-settings" type="button" data-i18n-aria-label="closeSettings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button>
    </div>
    <section class="preferences-section">
      <h3 data-i18n="appearance"></h3>
      <label class="field language-field"><span data-i18n="language"></span><select id="language-select"><option value="en">English</option><option value="es">Español</option><option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option></select></label>
      <h4 data-i18n="freshThemes"></h4><div class="theme-grid" id="fresh-themes"></div>
      <h4 data-i18n="glassTheme"></h4><div class="theme-grid glass-theme-grid" id="glass-themes"></div>
      <h4 data-i18n="gradientThemes"></h4><div class="theme-grid" id="gradient-themes"></div>
    </section>
    <section class="account-section" ${user ? '' : 'hidden'}>
      <div class="account-section-heading"><h3 data-i18n="account"></h3><button class="button sign-out-button" type="button" id="sign-out" data-i18n="signOut"></button></div>
      <p class="field-hint" data-i18n="accountChangeHint"></p>
      <form id="account-form">
        <label class="field"><span data-i18n="username"></span><input id="account-username" name="username" autocomplete="username" required minlength="2" maxlength="64"></label>
        <div class="field"><label for="account-current-password" data-i18n="currentPassword"></label><span class="password-field"><input id="account-current-password" name="current_password" type="password" autocomplete="current-password" data-password-field required maxlength="256"></span></div>
        <div class="field"><label for="account-new-password" data-i18n="newPassword"></label><span class="password-field"><input id="account-new-password" name="new_password" type="password" autocomplete="new-password" data-password-field minlength="8" maxlength="256"></span></div>
        <p class="field-hint" data-i18n="newPasswordHint"></p><p class="form-error" id="account-error" role="alert" hidden></p>
        <div class="dialog-actions"><button class="button primary" type="submit" id="save-account" data-i18n="saveAccount"></button></div>
      </form>
    </section>`;
  document.body.append(dialog);
  const fields = initPasswordFields(dialog);
  const errorBox = dialog.querySelector('#account-error');
  let busy = false;

  function refresh() {
    applyTranslations(dialog);
    dialog.querySelector('#language-select').value = getLocale();
    for (const id of ['fresh-themes', 'glass-themes', 'gradient-themes']) dialog.querySelector('#' + id).replaceChildren();
    THEMES.forEach((theme, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'theme-option';
      button.dataset.themeChoice = theme.id;
      button.setAttribute('aria-pressed', String(getTheme() === theme.id));
      const swatch = document.createElement('span');
      swatch.className = 'theme-swatch';
      swatch.style.setProperty('--theme-preview', theme.preview);
      swatch.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'theme-label';
      label.textContent = t(theme.nameKey);
      button.append(swatch, label);
      button.addEventListener('click', () => setTheme(theme.id));
      const group = index < 5 ? 'fresh-themes' : index === 5 ? 'glass-themes' : 'gradient-themes';
      dialog.querySelector('#' + group).append(button);
    });
  }
  function setBusy(value) {
    busy = value;
    dialog.querySelectorAll('#account-form input').forEach((input) => { input.readOnly = value; });
    fields.setDisabled(value);
    dialog.querySelector('#save-account').disabled = value;
    dialog.querySelector('#sign-out').disabled = value;
    dialog.querySelector('#close-settings').disabled = value;
    dialog.querySelector('#save-account').textContent = t(value ? 'saving' : 'saveAccount');
  }
  document.querySelector('#open-settings')?.addEventListener('click', () => {
    refresh();
    errorBox.hidden = true;
    if (user) dialog.querySelector('#account-username').value = user.username;
    dialog.querySelector('#account-current-password').value = '';
    dialog.querySelector('#account-new-password').value = '';
    fields.maskAll();
    dialog.showModal();
  });
  dialog.querySelector('#close-settings').addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  dialog.querySelector('#language-select').addEventListener('change', (event) => setLocale(event.target.value));
  window.addEventListener('localechange', refresh);
  window.addEventListener('themechange', () => {
    dialog.querySelectorAll('[data-theme-choice]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === getTheme())));
  });
  dialog.querySelector('#sign-out').addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    errorBox.hidden = true;
    try {
      await authRequest('/api/auth/logout', { method: 'POST', body: '{}' });
      redirectToLogin();
    } catch (error) {
      errorBox.textContent = errorMessage(error);
      errorBox.hidden = false;
      setBusy(false);
    }
  });
  dialog.querySelector('#account-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const body = {
      username: dialog.querySelector('#account-username').value.trim(),
      current_password: dialog.querySelector('#account-current-password').value,
    };
    const password = dialog.querySelector('#account-new-password').value;
    if (password) body.new_password = password;
    setBusy(true);
    errorBox.hidden = true;
    try {
      await authRequest('/api/account', { method: 'PATCH', body: JSON.stringify(body) });
      redirectToLogin(true);
    } catch (error) {
      if (error.status === 401 && error.code !== 'INVALID_CURRENT_PASSWORD') { redirectToLogin(); return; }
      errorBox.textContent = errorMessage(error);
      errorBox.hidden = false;
      setBusy(false);
    }
  });
  refresh();
  return dialog;
}
