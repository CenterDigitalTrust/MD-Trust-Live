export const languages = Object.freeze({en:'English',es:'Español',de:'Deutsch',fr:'Français',ru:'Русский',uk:'Українська',ja:'日本語'});

export function resolveLanguage(preferred, detected = []) {
  // Explicit choices override device preferences; unsupported variants fall back safely.
  try {
    if (typeof preferred === 'string' && Object.hasOwn(languages, preferred)) return preferred;
    for (const locale of detected) {
      if (typeof locale !== 'string') continue;
      const language = locale.toLowerCase().replaceAll('_', '-').split('-')[0];
      if (Object.hasOwn(languages, language)) return language;
    }
  } catch { /* An unavailable locale provider must not prevent the panel opening. */ }
  return 'en';
}

export function readLanguage(storage, detected = []) {
  // Sandboxed Twitch frames may disallow storage, so detection still works without it.
  try { return resolveLanguage(storage.getItem('mdtl.language'), detected); }
  catch { return resolveLanguage(null, detected); }
}

export function saveLanguage(storage, language) {
  // Return persistence success separately so the UI can still switch for this session.
  try {
    if (language === 'auto') storage.removeItem('mdtl.language');
    else if (Object.hasOwn(languages, language)) storage.setItem('mdtl.language', language);
    else return false;
    return true;
  } catch { return false; }
}
