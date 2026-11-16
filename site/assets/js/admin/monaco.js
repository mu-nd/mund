// Monaco Editor, loaded on demand from a CDN (it is large and only needed
// for the JSON view).  When it cannot be loaded the caller falls back to a
// plain text area, so the tool keeps working offline.

const VERSION = '0.52.2';
const BASE = `https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/${VERSION}/min`;

let promise = null;

export function loadMonaco(timeoutMs = 15000) {
  if (promise) return promise;
  promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout while loading the editor')), timeoutMs);
    const fail = (err) => { clearTimeout(timer); promise = null; reject(err); };
    // web workers must come from our own origin: start them from a small data: script
    window.MonacoEnvironment = {
      getWorkerUrl() {
        const source = `self.MonacoEnvironment = { baseUrl: '${BASE}/' };`
          + `importScripts('${BASE}/vs/base/worker/workerMain.js');`;
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
      },
    };
    const script = document.createElement('script');
    script.src = `${BASE}/vs/loader.min.js`;
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    script.onerror = () => fail(new Error('the editor could not be downloaded'));
    script.onload = () => {
      try {
        window.require.config({ paths: { vs: `${BASE}/vs` } });
        window.require(['vs/editor/editor.main'], () => {
          clearTimeout(timer);
          resolve(window.monaco);
        }, fail);
      } catch (err) {
        fail(err);
      }
    };
    document.head.appendChild(script);
  });
  return promise;
}

export function monacoTheme() {
  const forced = document.documentElement.dataset.theme;
  const dark = forced ? forced === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  return dark ? 'vs-dark' : 'vs';
}

/** Tell the JSON language service which schema applies to which file. */
export function configureSchemas(monaco, schemas) {
  const entries = [];
  if (schemas['lt.schema.json']) {
    entries.push({ uri: 'https://mund.invalid/schema/lt.schema.json', fileMatch: ['**/data/LT/**'], schema: schemas['lt.schema.json'] });
  }
  if (schemas['facilities.schema.json']) {
    entries.push({ uri: 'https://mund.invalid/schema/facilities.schema.json', fileMatch: ['**/data/master/facilities.json'], schema: schemas['facilities.schema.json'] });
  }
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true, allowComments: false, trailingCommas: 'error', enableSchemaRequest: false, schemas: entries,
  });
}

/** A model whose address makes the schema apply. */
export function modelFor(monaco, path, text) {
  const uri = monaco.Uri.parse(`inmemory://mund/${path}`);
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    if (existing.getValue() !== text) existing.setValue(text);
    return existing;
  }
  return monaco.editor.createModel(text, 'json', uri);
}
