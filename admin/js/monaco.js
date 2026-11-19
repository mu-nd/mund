// The JSON editor of the admin UI: Monaco Editor, loaded on demand from
// cdnjs (it is large and only needed for the JSON views), with the file's
// JSON Schema for checks and completion.  When Monaco cannot be loaded a
// plain text area takes its place, so the tool keeps working offline.

import { h, replace } from '../../site/assets/js/core/dom.js';
import { SCHEMA_FILES } from '../../site/assets/js/core/database.js';
import { T } from './i18n.js';

const VERSION = '0.52.2';
const BASE = `https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/${VERSION}/min`;

let promise = null;

function loadMonaco(timeoutMs = 15000) {
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

/** A model whose address is the file's path. */
function modelFor(monaco, path, text) {
  const uri = monaco.Uri.parse(`inmemory://mund/${path}`);
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    if (existing.getValue() !== text) existing.setValue(text);
    return existing;
  }
  return monaco.editor.createModel(text, 'json', uri);
}

/** The schema for a file's "format" (`formats`: format -> schema file), applied to that model only. */
function useSchema(monaco, model, text, schemas, formats) {
  let format = null;
  try { format = JSON.parse(text).format; } catch (err) { /* no schema for text that is not JSON */ }
  const name = formats[format];
  const schema = name ? schemas[name] : null;
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true, allowComments: false, trailingCommas: 'error', enableSchemaRequest: false,
    schemas: schema ? [{ uri: `https://mund.invalid/schema/${name}`, fileMatch: [model.uri.toString()], schema }] : [],
  });
}

/**
 * An editor for the text of one file.
 *   el        the editor area (Monaco fills it once it is loaded)
 *   note      a one-line state message for the card head
 *   value()   the current text
 *   dirty()   whether the text differs from `text`
 *   dispose()
 */
export function jsonPane(path, text, schemas, formats = SCHEMA_FILES) {
  const el = h('div', { class: 'monaco-holder' });
  const note = h('span', { class: 'small muted' }, T('エディタを読み込み中…', 'Loading the editor …'));
  let editor = null;
  let area = null;
  let disposed = false;

  loadMonaco().then((monaco) => {
    if (disposed || !el.isConnected) return;
    const model = modelFor(monaco, path, text);
    useSchema(monaco, model, text, schemas, formats);
    editor = monaco.editor.create(el, {
      model, automaticLayout: true, minimap: { enabled: false }, wordWrap: 'off',
      scrollBeyondLastLine: false, tabSize: 2, fontSize: 13, renderWhitespace: 'none',
    });
    note.textContent = T('スキーマに基づく入力補助が有効です(Ctrl+Space)', 'Schema-aware completion is available (Ctrl+Space)');
  }, (err) => {
    if (disposed || !el.isConnected) return;
    area = h('textarea', { class: 'json-fallback mono', spellcheck: 'false', rows: 30 });
    area.value = text;
    replace(el, area);
    note.textContent = T(`Monaco Editor を読み込めなかったため簡易エディタを表示しています(スキーマのチェックと補完はありません): ${err.message}`,
      `Monaco Editor could not be loaded; this plain editor has no schema checks or completion (${err.message})`);
  });

  const value = () => (editor ? editor.getValue() : area ? area.value : text);
  return {
    el,
    note,
    value,
    dirty: () => value() !== text,
    dispose() {
      disposed = true;
      if (editor) editor.dispose();
    },
  };
}
