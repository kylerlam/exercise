import { t } from './i18n.mjs';

const DRAFT_KEY = 'exercise-pending-record';

export function saveRecordDraft(draft) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    return true;
  } catch { return false; }
}

export function takeRecordDraft() {
  try {
    const text = sessionStorage.getItem(DRAFT_KEY);
    if (!text) return null;
    const draft = JSON.parse(text);
    sessionStorage.removeItem(DRAFT_KEY);
    return draft && typeof draft === 'object' && draft.values && typeof draft.values === 'object' ? draft : null;
  } catch { return null; }
}

export function clearRecordDraft() {
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* An explicit sign-out still works when storage is blocked. */ }
}

export async function authRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options, credentials: 'same-origin', cache: 'no-store',
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
    });
  } catch {
    throw new Error(t('loginNetworkError'));
  }
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || t('genericError'));
    error.code = body.code;
    error.status = response.status;
    throw error;
  }
  return body;
}

export function errorMessage(error) {
  if (error.code) {
    const key = 'errors.' + error.code;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return error.message || t('genericError');
}

export function redirectToLogin(updated = false) {
  if (!location.pathname.endsWith('/login.html')) {
    try { sessionStorage.setItem('exercise-next', location.pathname + location.search + location.hash); } catch { /* Storage preferences must not block sign-in. */ }
  }
  location.replace('/login.html' + (updated ? '?updated=1' : ''));
}

export function nextPage() {
  let next = '/';
  try {
    const stored = sessionStorage.getItem('exercise-next');
    if (stored?.startsWith('/') && !stored.startsWith('//')) {
      const target = new URL(stored, location.origin);
      if (target.origin === location.origin && !target.pathname.endsWith('/login.html')) next = target.pathname + target.search + target.hash;
    }
    sessionStorage.removeItem('exercise-next');
  } catch { /* Default to the main application. */ }
  return next;
}

export async function requireLogin() {
  const status = await authRequest('/api/auth/status');
  if (!status.authenticated) {
    redirectToLogin();
    return null;
  }
  return status.user;
}
