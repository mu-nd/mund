// The JSON editor of the admin UI: a card with the text of one file and a
// 反映 (Apply) button.  The text is edited in Monaco Editor, loaded on demand
// from cdnjs (it is large and only needed here), with the file's JSON Schema
// for checks and completion.  When Monaco cannot be loaded a plain text area
// takes its place, so the tool keeps working offline.

import { h, replace, card } from '../../site/assets/js/core/dom.js';
import * as jsonfmt from '../../site/assets/js/core/jsonfmt.js';
import { SCHEMA_FILES, schemaFor } from '../../site/assets/js/core/schema.js';
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

/** The schema for a file's "format", applied to that model only. */
function useSchema(monaco, model, text, schemas) {
  let format = null;
  try { format = JSON.parse(text).format; } catch (err) { /* no schema for text that is not JSON */ }
  const schema = schemaFor(format, schemas);
  const name = schema ? SCHEMA_FILES[format] : null;
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true, allowComments: false, trailingCommas: 'error', enableSchemaRequest: false,
    schemas: schema ? [{ uri: `https://mund.invalid/schema/${name}`, fileMatch: [model.uri.toString()], schema }] : [],
  });
}

/** The object a JSON text stands for; throws when the text is not JSON or not an object. */
export function parseObject(text) {
  const obj = jsonfmt.parse(text);
  if (!jsonfmt.isObject(obj)) throw new Error('the top level must be an object');
  return obj;
}

/**
 * An editor for the text of one file.
 *   el          the editor area (Monaco fills it once it is loaded)
 *   note        a one-line state message for the card head
 *   value()     the current text
 *   dirty()     whether the text differs from the text shown last
 *   show(text)  shows another text
 *   dispose()
 */
function jsonPane(path, text, schemas) {
  const el = h('div', { class: 'monaco-holder' });
  const note = h('span', { class: 'small muted' }, T('エディタを読み込み中…', 'Loading the editor …'));
  let monaco = null;
  let editor = null;
  let area = null;
  let disposed = false;
  let readOnly = false;

  loadMonaco().then((loaded) => {
    if (disposed || !el.isConnected) return;
    monaco = loaded;
    const model = modelFor(monaco, path, text);
    useSchema(monaco, model, text, schemas);
    editor = monaco.editor.create(el, {
      model, readOnly, automaticLayout: true, minimap: { enabled: false }, wordWrap: 'off',
      scrollBeyondLastLine: false, tabSize: 2, fontSize: 13, renderWhitespace: 'none',
    });
    note.textContent = T('スキーマに基づく入力補助が有効です(Ctrl+Space)', 'Schema-aware completion is available (Ctrl+Space)');
  }, (err) => {
    if (disposed || !el.isConnected) return;
    area = h('textarea', { class: 'json-fallback mono', spellcheck: 'false', rows: 30 });
    area.value = text;
    area.readOnly = readOnly;
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
    setReadOnly(value) {
      readOnly = value;
      if (editor) editor.updateOptions({ readOnly });
      if (area) area.readOnly = readOnly;
    },
    show(next) {
      text = next;
      if (editor) {
        useSchema(monaco, editor.getModel(), text, schemas);
        editor.setValue(text);
      } else if (area) {
        area.value = text;
      }
    },
    dispose() {
      disposed = true;
      if (editor) editor.dispose();
    },
  };
}

/**
 * The card of the JSON text of one file, with a 反映 (Apply) button.
 *   title         the card title
 *   path          the file's path (the address of the editor's model)
 *   text()        the file's text, shown again once edited text is taken over
 *   schemas       the JSON Schemas (the one of the file's "format" checks the text)
 *   toast         the page's toast (main.js)
 *   onApply(obj)  takes over the object the edited text stands for
 *   help          a note under the editor (optional)
 * Returns
 *   el
 *   dirty()       whether the text was edited since it was shown
 *   apply()       hands edited text to onApply and shows text(); false (with a toast) when it is not a JSON object
 *   dispose()
 */
export function jsonCard({ title, path, text, schemas, toast, onApply, help = null }) {
  const pane = jsonPane(path, text(), schemas);

  function apply() {
    if (!pane.dirty()) return true;
    let obj;
    try {
      obj = parseObject(pane.value());
    } catch (err) {
      toast(T(`JSON として読めません: ${err.message}`, `Not valid JSON: ${err.message}`), 'bad');
      return false;
    }
    onApply(obj);
    pane.show(text());
    return true;
  }

  const button = h('button', { class: 'btn primary', type: 'button', onclick: () => {
    if (apply()) toast(T('反映しました(まだ保存されていません)', 'Applied (not saved yet)'));
  } }, T('反映', 'Apply'));
  return {
    el: card({ title, controls: h('div', { class: 'row' }, pane.note, button) },
      pane.el, help ? h('div', { class: 'card-body small muted' }, help) : null),
    dirty: pane.dirty,
    setReadOnly: pane.setReadOnly,
    apply,
    dispose: pane.dispose,
  };
}
