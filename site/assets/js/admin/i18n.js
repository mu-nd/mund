// Two-language user interface (Japanese / English).
// Texts are written where they are used:  T('保存', 'Save')

const KEY = 'mund-admin:lang';

function initial() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'ja' || saved === 'en') return saved;
  } catch (err) { /* ignore */ }
  return (navigator.language || 'en').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

let lang = initial();

export const T = (ja, en) => (lang === 'ja' ? ja : en);
export const getLang = () => lang;

export function setLang(value) {
  lang = value === 'ja' ? 'ja' : 'en';
  try { localStorage.setItem(KEY, lang); } catch (err) { /* ignore */ }
  document.documentElement.lang = lang;
}

document.documentElement.lang = lang;
