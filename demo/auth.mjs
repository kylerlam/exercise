import { t } from './i18n.mjs';
import { createDemoStore } from './demo-store.mjs';
import { installDemoBanner, demoMessage } from './demo-banner.mjs';

const store = createDemoStore();
installDemoBanner(store);

// A demo never makes a network request or authenticates against the private app.
export const authRequest = (path, options) => store.request(path, options);
export function errorMessage(error) {
  if (error.code?.startsWith('DEMO_')) return demoMessage(error.code);
  const key = 'errors.' + error.code;
  const translated = t(key);
  return translated === key ? error.message || t('genericError') : translated;
}
export const redirectToLogin = () => {};
export const nextPage = () => '/';
export const requireLogin = async () => null;
export const saveRecordDraft = () => false;
export const takeRecordDraft = () => null;
export const clearRecordDraft = () => {};
