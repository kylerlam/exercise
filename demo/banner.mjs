import { getLocale } from './i18n.mjs';
import { DEMO_STORAGE_KEY, hongKongDay } from './demo-store.mjs';

const messages = {
  en: {
    banner: 'Demo: data stays in this browser and resets daily at midnight in Hong Kong. All samples are fictional.',
    reset: 'Reset samples', DEMO_STORAGE_ERROR: 'Browser storage is unavailable or full. Allow storage or free space, then try again.',
    DEMO_STORAGE_INVALID: 'Saved demo data is damaged. Reset samples to start again; nothing has been overwritten.',
    DEMO_CLOCK_ERROR: 'The device clock moved backwards. Check the date or reset samples to continue.',
    DEMO_LOCK_UNAVAILABLE: 'This browser cannot safely coordinate demo storage. Use a browser that supports Web Locks.',
  },
  es: {
    banner: 'Demo: los datos quedan en este navegador y se reinician cada medianoche de Hong Kong. Los ejemplos son ficticios.',
    reset: 'Restablecer ejemplos', DEMO_STORAGE_ERROR: 'El almacenamiento está bloqueado o lleno. Habilítalo o libera espacio e inténtalo de nuevo.',
    DEMO_STORAGE_INVALID: 'Los datos de demostración están dañados. Restablece los ejemplos; no se ha sobrescrito nada.',
    DEMO_CLOCK_ERROR: 'El reloj del dispositivo retrocedió. Comprueba la fecha o restablece los ejemplos.',
    DEMO_LOCK_UNAVAILABLE: 'Este navegador no puede coordinar el almacenamiento. Usa uno compatible con Web Locks.',
  },
  'zh-CN': {
    banner: '演示版：数据仅保存在此浏览器，每天香港时间午夜重置。所有示例均为虚构。',
    reset: '重置示例', DEMO_STORAGE_ERROR: '浏览器存储被禁用或已满。请允许存储或清理空间后重试。',
    DEMO_STORAGE_INVALID: '演示数据已损坏。可重置示例重新开始，原数据尚未被覆盖。',
    DEMO_CLOCK_ERROR: '设备时间已回拨。请检查日期，或重置示例后继续。',
    DEMO_LOCK_UNAVAILABLE: '此浏览器不支持安全协调演示数据，请使用支持 Web Locks 的浏览器。',
  },
  'zh-TW': {
    banner: '示範版：資料僅儲存在此瀏覽器，每天香港時間午夜重設。所有範例均為虛構。',
    reset: '重設範例', DEMO_STORAGE_ERROR: '瀏覽器儲存空間被停用或已滿。請允許儲存或清理空間後重試。',
    DEMO_STORAGE_INVALID: '示範資料已損壞。可重設範例重新開始，原資料尚未被覆寫。',
    DEMO_CLOCK_ERROR: '裝置時間已回撥。請檢查日期，或重設範例後繼續。',
    DEMO_LOCK_UNAVAILABLE: '此瀏覽器不支援安全協調示範資料，請使用支援 Web Locks 的瀏覽器。',
  },
};
export const demoMessage = (key) => (messages[getLocale()] || messages.en)[key] || key;

export function installDemoBanner(store) {
  const banner = document.createElement('section');
  banner.className = 'panel demo-banner';
  banner.setAttribute('aria-label', 'Demo');
  const text = document.createElement('p');
  const reset = document.createElement('button');
  reset.className = 'button';
  reset.type = 'button';
  reset.id = 'demo-reset';
  const error = document.createElement('p');
  error.className = 'demo-storage-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  banner.append(text, reset, error);
  document.querySelector('main').prepend(banner);
  let errorCode, day = hongKongDay(), busy = false;
  function translate() {
    text.textContent = demoMessage('banner');
    reset.textContent = demoMessage('reset');
    if (errorCode) error.textContent = demoMessage(errorCode);
  }
  function problem(failure) {
    errorCode = failure.code || 'DEMO_STORAGE_ERROR';
    error.textContent = demoMessage(errorCode);
    error.hidden = false;
  }
  reset.addEventListener('click', async () => {
    if (busy) return;
    busy = reset.disabled = true;
    try { await store.reset(); location.reload(); }
    catch (failure) { problem(failure); busy = reset.disabled = false; }
  });
  async function refresh(notify = false) {
    try {
      const result = await store.refresh();
      error.hidden = true;
      errorCode = null;
      if (notify || result.day !== day) window.dispatchEvent(new Event('exercise-demo-update'));
      day = result.day;
    } catch (failure) { problem(failure); }
  }
  window.addEventListener('localechange', translate);
  window.addEventListener('storage', (event) => { if (event.key === DEMO_STORAGE_KEY || event.key === null) void refresh(true); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); });
  setInterval(() => { void refresh(); }, 60000);
  translate();
  void refresh();
}
