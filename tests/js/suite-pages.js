// Tests of the pure modules of the pages (site/assets/js/pages: model.js,
// selection.js, route.js).  Registered next to suite.js by
// run-node.mjs and by the browser test page; `modules` and `env` as there.
//
// The published files of a version (manifest.json, master.json, LT.json,
// csv/LT.csv) are those tools/mundlib/build.py writes for the test database
// with one entry added whose source gives no uncertainty
// (tests/vectors/published.json, written by tests/make_vectors.py).

export function register(h, modules, env) {
  const { jsonfmt, cite, model, selection, route } = modules;

  const vector = async () => JSON.parse(await env.text('vectors', 'published.json'));

  /** The version as the pages build it from its published files (`edit` changes the entries of LT.json first). */
  async function published({ edit = null } = {}) {
    const { manifest, master, lt } = await vector();
    const parsed = jsonfmt.parse(lt);
    if (edit) edit(parsed.data);
    return model.buildVersion({ label: manifest.label, manifest, master, lt: parsed });
  }

  const idsOf = (rows) => rows.map((r) => r.entry.datasetId);
  const asRecords = (text) => {
    const [header, ...records] = selection.parseCsv(text);
    return records.map((r) => Object.fromEntries(header.fields.map((c, i) => [c, r.fields[i]])));
  };

  // Exercise the form through its events. Node supplies EventTarget but has no document.
  async function withConverter(check, search = '') {
    const inNode = typeof document === 'undefined';
    const originalUrl = inNode ? null : location.href;
    if (inNode) {
      class TestNode extends EventTarget {
        constructor(tagName = '', text = '') {
          super();
          this.tagName = tagName.toUpperCase();
          this.text = text;
          this.value = '';
          this.childNodes = [];
          this.attributes = new Map();
        }
        get children() { return this.childNodes.filter((n) => n.tagName); }
        get textContent() { return this.text + this.childNodes.map((n) => n.textContent).join(''); }
        set textContent(text) { this.replaceChildren(); this.text = text; }
        appendChild(child) { this.childNodes.push(child); }
        replaceChildren() { this.childNodes = []; this.text = ''; }
        setAttribute(key, value) { this.attributes.set(key, value); }
        getAttribute(key) { return this.attributes.get(key) ?? null; }
        removeAttribute(key) { this.attributes.delete(key); }
      }
      globalThis.Node = TestNode;
      globalThis.document = { createElement: (tag) => new TestNode(tag), createTextNode: (s) => new TestNode('', s) };
      globalThis.location = { search };
    } else {
      const url = new URL(originalUrl);
      url.search = search;
      history.replaceState(history.state, '', url);
    }
    try {
      const root = document.createElement('div');
      const version = await published();
      modules.converter.renderConverter(root, { version });
      const descendants = (n) => [n, ...Array.from(n.children).flatMap(descendants)];
      const find = (tag, attr, value) => descendants(root).find((n) =>
        n.tagName === tag.toUpperCase() && (!attr || (attr === 'value' ? n.value : n.getAttribute(attr)) === value));
      const input = (field, value) => { field.value = value; field.dispatchEvent(new Event('input')); };
      await check({ root, find, input, version });
    } finally {
      if (inNode) { delete globalThis.Node; delete globalThis.document; delete globalThis.location; }
      else history.replaceState(history.state, '', originalUrl);
    }
  }

  h.test('converter: a link to an element outside the tables names the element', (t) =>
    withConverter(({ root, find }) => {
      t.ok(root.textContent.includes('Cf') && root.textContent.includes('isotope range'));
      t.ok(!find('table'));
      t.ok(find('a').getAttribute('href').endsWith('/tools/converter/?v=v1'));
    }, '?z=98'));

  h.test('converter: custom Huff factor keeps the typed digits', (t) => withConverter(({ find, input }) => {
    const checkbox = find('input', 'type', 'checkbox');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    for (const q of ['0.999980', '1.0e-5']) {
      input(find('input', 'aria-label', 'Huff factor Q'), q);
      const rows = find('tbody').children;
      t.equal(rows[0].children[1].textContent, q);
      t.equal(rows[1].children[1].textContent, '0.9924');
    }
  }));

  h.test('converter: an element change keeps the active custom Huff factor', (t) => withConverter(({ find, input }) => {
    input(find('input', 'id', 'c-val'), '812');
    const checkbox = find('input', 'type', 'checkbox');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    const own = find('input', 'aria-label', 'Huff factor Q');
    input(own, '0.950');
    const element = find('select', 'id', 'c-el');
    element.value = '82';
    element.dispatchEvent(new Event('change'));
    t.equal(own.value, '0.950');
    const rows = find('tbody').children;
    t.equal(rows[0].children[1].textContent, '0.950');
    t.equal(rows[1].children[1].textContent, '0.8473');
  }));

  h.test('converter: clicking the selected quantity preserves both fields', (t) => withConverter(({ find, input }) => {
    const value = find('input', 'id', 'c-val'), unc = find('input', 'id', 'c-unc');
    input(value, '812.0');
    input(unc, '2.10');
    find('button', 'value', 'lifetime').dispatchEvent(new Event('click'));
    t.equal(value.value, '812.0');
    t.equal(unc.value, '2.10');
  }));

  h.test('converter: silicon starting values describe one lifetime', (t) => withConverter(({ find, version }) => {
    for (const mode of modules.convert.KINDS) {
      find('button', 'value', mode).dispatchEvent(new Event('click'));
      const value = find('input', 'id', 'c-val').value, unc = find('input', 'id', 'c-unc').value;
      const c = version.physics.convert(14, 0, mode, Number(value), Number(unc), modules.convert.OBSERVABLES[mode].unit);
      // the start values carry the displayed digits: back to the lifetime within that rounding
      t.close(c.lifetime_ns, 756.0, 1e-4, mode);
      t.close(c.lifetime_ns_unc, 1.0, 0.05, mode);
      if (mode === 'capture_rate') t.deepEqual([value, unc], ['0.8710', '0.0017']);
    }
  }));

  h.test('converter: unusable inputs name and describe the invalid field', (t) => withConverter(({ find, input }) => {
    const value = find('input', 'id', 'c-val');
    const unc = find('input', 'id', 'c-unc');
    const own = find('input', 'aria-label', 'Huff factor Q');
    const checkbox = find('input', 'type', 'checkbox');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    const check = (field, invalid, name, valid) => {
      input(field, invalid);
      t.equal(field.getAttribute('aria-invalid'), 'true', invalid);
      const message = find('p', 'role', 'alert');
      t.ok(message && message.textContent.toLowerCase().includes(name), invalid);
      t.equal(field.getAttribute('aria-describedby'), message.getAttribute('id'));
      t.ok(!find('table'));
      input(field, valid);
      t.ok(field.getAttribute('aria-invalid') !== 'true' && !field.getAttribute('aria-describedby'));
      t.ok(find('table') && !find('p', 'role', 'alert'));
    };
    check(value, 'abc', 'lifetime', '756.0');
    check(value, '0', 'lifetime', '756.0');
    check(value, '1e-320', 'lifetime', '756.0');
    check(unc, '-1', 'uncertainty', '');
    check(unc, 'abc', 'uncertainty', '1.0');
    check(own, '0', 'huff factor', '1');
    find('button', 'value', 'capture_probability').dispatchEvent(new Event('click'));
    check(value, '101', 'capture probability', '50');
    check(unc, '1e308', 'uncertainty', '0');
    input(value, '-1');
    input(unc, '-2');
    const alert = find('p', 'role', 'alert');
    t.ok(alert.textContent.includes('capture probability') && alert.textContent.includes('uncertainty'));
    t.ok([value, unc].every((field) => field.getAttribute('aria-invalid') === 'true'));
  }));

  h.test('converter: probability input bounds', (t) => withConverter(({ root, find, input }) => {
    find('button', 'value', 'capture_probability').dispatchEvent(new Event('click'));
    for (const value of ['-1', '101', '100']) {
      input(find('input', 'id', 'c-val'), value);
      t.ok(!find('table'), value);
      t.ok(/capture probability/i.test(find('p', 'class', 'notice warn').textContent), value);
    }
    input(find('input', 'id', 'c-val'), '0');
    t.ok(find('table'), root.textContent);
  }));

  h.test('format: lifetime of the Si-32 evaluation', async (t) => {
    const row = (await published()).byId.get('22753a5a8be8');
    t.equal(modules.format.formatConverted(row.conv, 'lifetime'), '990 ± 100');
  });

  // Each page has its own address, event handlers and resize observers.
  async function inFrame(search, check, width = 900) {
    const frame = document.createElement('iframe');
    frame.style.cssText = `position:absolute;left:-10000px;width:${width}px;height:700px`;
    frame.src = new URL('vectors/ids.json', import.meta.url);
    await new Promise((resolve) => { frame.onload = resolve; document.body.appendChild(frame); });
    try {
      const win = frame.contentWindow;
      win.history.replaceState(null, '', '?' + search);
      const root = win.document.createElement('main');
      win.document.body.replaceChildren(root);
      await Promise.all(['base', 'pages'].map((name) => new Promise((resolve, reject) => {
        const css = win.document.createElement('link');
        css.rel = 'stylesheet';
        css.href = route.pageUrl('') + `assets/css/${name}.css`;
        css.onload = resolve;
        css.onerror = reject;
        win.document.head.appendChild(css);
      })));
      const importPage = (name) => win.Function('url', 'return import(url)')(
        route.pageUrl('') + `assets/js/pages/${name}.js` + new URL(import.meta.url).search);
      await check(root, win, frame, importPage);
    } finally { frame.remove(); }
  }

  function inExplorer(version, search, check, width) {
    return inFrame(search, async (root, win, frame, importPage) => {
      const { renderExplorer } = await importPage('explorer');
      if (typeof version === 'function') version = await version(win, importPage);
      renderExplorer(root, { version, config: { data: { title: 'Test data', author: 'Test team' } } });
      await check(root, win, frame);
    }, width);
  }

  async function openDataPage(root, win, importPage, page, files) {
    root.id = 'main';
    win.document.body.dataset.page = page;
    const theme = win.document.createElement('button');
    theme.id = 'theme';
    win.document.body.appendChild(theme);
    const requested = [];
    win.fetch = async (url) => {
      const file = new URL(url).pathname.split('/').pop();
      requested.push(file);
      const value = files[file];
      return { ok: value !== undefined, status: 404, text: async () => typeof value === 'string' ? value : JSON.stringify(value) };
    };
    await importPage('main');
    if (!root.children.length) await new Promise((resolve) => {
      const observer = new win.MutationObserver(() => { observer.disconnect(); resolve(); });
      observer.observe(root, { childList: true });
    });
    return requested;
  }

  if (typeof document !== 'undefined') h.test('table: a source lifetime in microseconds keeps its uncertainty components in nanoseconds', async (t) => {
    const version = await published({ edit: (data) => {
      data[0].observable = { kind: 'lifetime', lifetime: { unit: 'us', value: 0.7514, uncertainties: [
        { source: 'statistical', value: 0.0008 }, { source: 'systematic', value: 0.0007 },
      ] } };
    } });
    await inExplorer(version, '', (root) => {
      const row = root.querySelector(`tr[data-id="${version.rows[0].entry.datasetId}"]`);
      t.ok(row.querySelector('.measured').textContent.includes('751.4 ± 0.8 (stat) ± 0.7 (syst)'));
    });
  });

  if (typeof document !== 'undefined') h.test('chart: 100 percent capture probability has a measured point and no derived rate', async (t) => {
    const version = await published({ edit: (data) => {
      data[0].observable = { kind: 'capture_probability', capture_probability: {
        unit: '%', value: 100, uncertainties: [{ source: 'total', value: 1 }],
      } };
    } });
    const key = version.rows[0].entry.datasetId;
    await inExplorer(version, 'q=capture_probability', (root) => {
      t.ok(root.querySelector(`.chart-mark[data-key="${key}"]`));
      root.querySelector('button[value="capture_rate"]').click();
      t.equal(root.querySelector(`.chart-mark[data-key="${key}"]`), null);
    });
  });

  if (typeof document !== 'undefined') h.test('downloads: reject a source file from another revision at export', async (t) => {
    const { manifest, master, lt, csv } = await vector();
    for (const [kind, stale] of [['CSV', 'csv/LT.csv'], ['JSON', 'LT.json'], ['JSON', 'master.json'], ['CSV', ''], ['JSON', '']]) {
      const texts = { 'manifest.json': JSON.stringify(manifest), 'master.json': JSON.stringify(master), 'LT.json': lt, 'csv/LT.csv': csv };
      if (stale === 'master.json') texts[stale] = JSON.stringify({ ...master, version: 'another' });
      if (stale === 'LT.json' || stale === 'csv/LT.csv') texts[stale] = texts[stale].replace('743.9', '748.9');
      let download = '';
      await inExplorer(async (win, importPage) => {
        win.fetch = async (url) => ({ ok: true, text: async () => texts[url.split('/v1/')[1]] });
        win.HTMLAnchorElement.prototype.click = function () { download = this.getAttribute('download'); };
        return (await importPage('store')).loadVersion(manifest);
      }, '', async (root) => {
        const button = [...root.querySelectorAll('button')].find((b) => b.textContent === kind);
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        t.equal(Boolean(download), !stale, kind + ' with ' + stale);
        if (stale) {
          const message = root.querySelector('.element-heading [role="status"]').textContent;
          t.ok(/reload/i.test(message), message);
        }
      });
    }
  });

  if (typeof document !== 'undefined') h.test('version choice: arrow then Tab or Enter opens the choice and Escape cancels it', async (t) => {
    const { manifest, master, lt } = await vector();
    const files = { 'versions.json': VERSIONS, 'config.json': { data: {} }, 'manifest.json': manifest, 'master.json': master, 'LT.json': lt };
    for (const key of ['Tab', 'Enter', 'Escape']) {
      await inFrame('v=v1', async (root, win, frame, importPage) => {
        await openDataPage(root, win, importPage, 'downloads', files);
        const select = root.querySelector('.version-select');
        const press = (k) => select.dispatchEvent(new win.KeyboardEvent('keydown', { key: k }));
        select.focus();
        press('ArrowDown');
        select.value = 'latest';
        select.dispatchEvent(new win.Event('change'));
        press(key);
        select.dispatchEvent(new win.FocusEvent('blur'));
        t.equal(select.value, 'v1', 'the visible label matches the displayed data until navigation');
        if (key !== 'Escape') await new Promise((resolve) => { frame.onload = resolve; });
        t.equal(new URLSearchParams(win.location.search).get('v'), key === 'Escape' ? 'v1' : 'latest');
      });
    }
  });

  if (typeof document !== 'undefined') h.test('detail: resizing an open entry updates the background controls', async (t) => {
    const version = await published();
    await inExplorer(version, 'id=' + version.rows[0].entry.datasetId, async (root, win, frame) => {
      const panel = root.querySelector('.detail');
      const background = [...root.children].filter((el) => el !== panel);
      const phone = win.matchMedia('(max-width: 640px)');
      for (const width of [1600, 600, 900]) {
        const changed = new Promise((resolve) => phone.addEventListener('change', resolve, { once: true }));
        frame.style.width = width + 'px';
        await changed;
        t.ok(!panel.hidden && !panel.inert);
        t.ok(background.every((el) => el.inert === (width <= 640)), 'background at ' + width);
      }
    }, 600);
  });

  if (typeof document !== 'undefined') h.test('detail: Tab from the header goes on in the panel that lies over the page', async (t) => {
    for (const width of [1280, 1600, 600]) {
      const version = await published();
      const id = version.rows[0].entry.datasetId;
      await inExplorer((win) => {
        const header = win.document.createElement('header');
        header.className = 'site-header';
        header.append(win.document.createElement('button'), win.document.createElement('button'));
        win.document.body.prepend(header);
        return version;
      }, 'id=' + id, async (root, win) => {
        const [first, last] = win.document.querySelectorAll('.site-header button');
        const panel = root.querySelector('.detail');
        const tab = (el) => el.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        first.focus();
        tab(first);
        t.equal(win.document.activeElement, first, 'Tab between header controls is left alone at ' + width);
        last.focus();
        t.equal(!tab(last), width === 1280, 'Tab is taken over at ' + width);
        t.equal(panel.contains(win.document.activeElement), width === 1280, 'focus in the panel at ' + width);
      }, width);
    }
  });

  if (typeof document !== 'undefined') h.test('explorer: a theory-only address can have an empty result', async (t) => {
    await inExplorer(await published(), 'ds=TH', (root) => {
      t.equal(root.querySelectorAll('tr[data-id]').length, 0);
      t.ok(root.querySelector('.chart-empty').textContent.includes('No data'));
      const hint = () => root.textContent.includes('Click a point or an element to see its data.');
      t.equal(hint(), false, 'no hint about points beside the one message');
      t.ok(root.querySelector('.element-heading .no-print').hidden);
      root.querySelector('[data-kind="EXP"]').click();
      t.ok(root.querySelector('tr[data-id]'));
      t.ok(hint());
    });
  });

  if (typeof document !== 'undefined') h.test('explorer: the nuclide control shows and clears a mass-only address', async (t) => {
    const version = await published();
    for (const a of ['28', '0', '999']) await inExplorer(version, 'a=' + a, (root, win) => {
      const select = root.querySelector('[aria-label="Nuclide"]');
      t.equal(select.value, a);
      t.equal(select.disabled, false);
      t.equal(root.querySelectorAll('tr[data-id]').length, selection.selectRows(version.rows, { a }).length);
      select.value = '';
      select.dispatchEvent(new win.Event('change'));
      t.equal(root.querySelectorAll('tr[data-id]').length, version.rows.length);
      t.equal(new URLSearchParams(win.location.search).has('a'), false);
    });
  });

  if (typeof document !== 'undefined') h.test('explorer: an unresolved DataID names the missing entry and version', async (t) => {
    await inExplorer(await published(), 'id=ffffffffffff', (root, win) => {
      const notice = root.querySelector('.notice');
      t.ok(notice && notice.textContent.includes('ffffffffffff') && notice.textContent.includes('1.0.0'));
      t.ok(root.querySelector('.detail').hidden);
      notice.querySelector('button').click();
      t.equal(new URLSearchParams(win.location.search).has('id'), false);
      t.ok(notice.hidden);
    });
  });

  if (typeof document !== 'undefined') h.test('chart: an evaluated point stays selected through resize', async (t) => {
    const version = await published();
    const id = version.rows.find((r) => r.code === 'EVAL').entry.datasetId;
    await inExplorer(version, '', async (root, win, frame) => {
      root.querySelector(`tr[data-id="${id}"] a`).click();
      const selected = () => root.querySelector('.chart-mark.selected');
      t.equal(selected()?.dataset.key, id);
      t.equal(win.getComputedStyle(selected()).opacity, '1');
      const redrawn = new Promise((resolve) => {
        const observer = new win.MutationObserver(() => { observer.disconnect(); resolve(); });
        observer.observe(root.querySelector('.chart-plot').parentNode, { childList: true });
      });
      frame.style.width = '800px';
      await redrawn;
      t.equal(selected()?.dataset.key, id);
    });
  });

  if (typeof document !== 'undefined') h.test('entry labels: natural aluminium retains its qualifier at the effective mass', async (t) => {
    const id = 'dd91adba8444';
    const version = await published({ edit: (data) => { data.find((r) => r.datasetId === id).nuclide.mass = 0; } });
    await inExplorer(version, 'z=13&id=' + id, (root, win) => {
      const nat = '[title="Target of natural abundance"]';
      t.ok(root.querySelector(`tr[data-id="${id}"] ${nat}`));
      t.ok(root.querySelector('.detail h2 ' + nat));
      root.querySelector(`.chart-mark[data-key="${id}"]`).dispatchEvent(new win.MouseEvent('pointermove', { bubbles: true }));
      t.ok(root.querySelector('.chart-tooltip .tip-name ' + nat));
      root.querySelector('tr[data-id="b15200d13c23"] a').click();
      t.ok(root.querySelector('.detail .id-list ' + nat));
      t.equal(root.querySelector('.detail h2 ' + nat), null, 'explicit isotope');
    });
  });

  if (typeof document !== 'undefined') h.test('isotope chart: labels fit on a phone and all points are plotted', async (t) => {
    const version = await published({ edit: (data) => {
      data.slice(0, 16).forEach((r, i) => { r.nuclide = { element: 'Sn', mass: i ? 111 + i : 0, isomer: 0 }; });
    } });
    await inExplorer(version, 'z=50', (root) => {
      const ticks = [...root.querySelectorAll('.chart-tick')].filter((el) => el.querySelector('tspan'));
      t.ok(ticks.length > 1);
      for (let i = 1; i < ticks.length; i++) {
        t.ok(ticks[i - 1].getBoundingClientRect().right < ticks[i].getBoundingClientRect().left, 'adjacent isotope labels');
      }
      t.equal(root.querySelectorAll('.chart-mark').length, 16);
    }, 320);
  });

  if (typeof document !== 'undefined') h.test('chart: a tooltip remains hoverable and Escape dismisses it', async (t) => {
    await inExplorer(await published(), 'z=14', (root, win) => {
      const mark = root.querySelector('.chart-mark');
      const tip = root.querySelector('.chart-tooltip');
      mark.dispatchEvent(new win.MouseEvent('pointermove', { bubbles: true }));
      t.equal(tip.hidden, false);
      t.ok(win.getComputedStyle(tip).pointerEvents !== 'none');
      mark.ownerSVGElement.dispatchEvent(new win.MouseEvent('pointerleave', { relatedTarget: tip }));
      tip.dispatchEvent(new win.MouseEvent('pointermove', { bubbles: true }));
      t.equal(tip.hidden, false);
      win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      t.equal(tip.hidden, true);
    });
  });

  if (typeof document !== 'undefined') h.test('periodic table: each accessible name includes its chemical symbol', async (t) => {
    await inExplorer(await published(), '', (root) => {
      for (const cell of root.querySelectorAll('.pt-cell')) {
        const symbol = cell.querySelector('.pt-sym').textContent;
        t.ok(cell.getAttribute('aria-label').split(/\W+/).includes(symbol), symbol);
      }
    });
  });

  if (typeof document !== 'undefined') h.test('pages: Downloads and the converter work without measurement files', async (t) => {
    const { manifest, master } = await vector();
    for (const page of ['downloads', 'tools/converter']) await inFrame('v=v1', async (root, win, frame, importPage) => {
      const files = { 'versions.json': VERSIONS, 'config.json': { data: {} }, 'manifest.json': manifest };
      if (page === 'tools/converter') files['master.json'] = master;
      const requested = await openDataPage(root, win, importPage, page, files);
      t.deepEqual(requested.sort(), Object.keys(files).sort());
      t.ok(page === 'downloads' ? root.querySelector('a[href$=".zip"]') : root.querySelector('tbody .num'));
    });
  });

  if (typeof document !== 'undefined') h.test('home: the citation instructions match a failed data load', async (t) => {
    await inFrame('v=v1', async (root, win, frame, importPage) => {
      await openDataPage(root, win, importPage, '', { 'versions.json': VERSIONS, 'config.json': {
        paper: { title: 'Test paper', authors: [{ family: 'Example', given: 'T.' }], year: 2026 },
      } });
      const cite = root.querySelector('#cite');
      t.equal(cite.querySelectorAll('.cite-wrap').length, 1);
      t.ok(!cite.querySelector('p').textContent.includes('both'));
    });
  });

  if (typeof document !== 'undefined') h.test('downloads: file and archive sizes use decimal units', async (t) => {
    const { manifest } = await vector();
    manifest.files = [999, 1000, 252490, 1000000].map((bytes) => ({ bytes, path: bytes + '.json' }));
    manifest.archive.bytes = 1550000;
    await inFrame('v=v1', async (root, win, frame, importPage) => {
      await openDataPage(root, win, importPage, 'downloads', {
        'versions.json': VERSIONS, 'config.json': { data: {} }, 'manifest.json': manifest,
      });
      const sizes = [...root.querySelectorAll('tbody td.num')].map((el) => el.textContent);
      t.deepEqual(sizes, ['', '999 B', '1 kB', '252 kB', '1.0 MB']);
      t.ok(root.querySelector('a[href$=".zip"]').textContent.includes('1.6 MB'));
    });
  });

  if (typeof document !== 'undefined') h.test('explorer: download titles describe a single selected entry', async (t) => {
    await inExplorer(await published(), 'z=14&a=28&ds=CUR', (root) => {
      t.equal(root.querySelectorAll('tr[data-id]').length, 1);
      for (const button of root.querySelectorAll('.element-heading button')) {
        t.ok(button.title.startsWith('The 1 entry shown below'), button.title);
      }
    });
  });

  if (typeof document !== 'undefined') h.test('chart: a click selects the marker under the pointer', (t) => {
    const holder = document.body.appendChild(document.createElement('div'));
    holder.style.width = '540px';
    let selected;
    const stop = modules.chart.renderChart(holder, {
      series: [{ context: true, points: [{ x: 10, y: 1 }] }, { points: [{ x: 11, y: 1 }] }],
      x: { type: 'linear', domain: [0, 100] }, y: {}, keyOf: (p) => String(p.x),
      tooltip: () => '', onSelect: (p) => { selected = p.x; },
    });
    try {
      const mark = holder.querySelector('.chart-mark');
      const box = mark.getBoundingClientRect();
      const click = { bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
      mark.dispatchEvent(new MouseEvent('click', click));
      t.equal(selected, 10, 'a direct hit on the evaluated point');
      selected = null;
      holder.querySelector('.chart-svg').dispatchEvent(new MouseEvent('click', click));
      t.equal(selected, 10, 'the closest center when the pointer misses the markers');
    } finally { stop(); holder.remove(); }
  });

  // ---------------------------------------------------------------- selection
  h.test('selection: the filter of the tables', async (t) => {
    const { rows, manifest } = await published();
    const { counts } = manifest.sublibraries.LT;
    t.equal(rows.length, Object.values(counts).reduce((s, n) => s + n), 'the entries the manifest counts');
    t.equal(selection.selectRows(rows).length, rows.length, 'no filter: everything');
    t.equal(selection.selectRows(rows, { ds: ['EXP'] }).length, counts.EXP);
    t.equal(selection.selectRows(rows, { ds: new Set(['CUR']) }).length, counts.CUR, 'codes as a Set, as in the explorer');
    t.equal(selection.selectRows(rows, { ds: [] }).length, 0);
    const si = selection.selectRows(rows, { z: 14 });
    t.ok(si.length > 0 && si.every((r) => r.z === 14));
    t.equal(si.length, rows.filter((r) => r.z === 14).length);
    const si28 = selection.selectRows(rows, { z: 14, a: '28' });
    t.ok(si28.length > 0 && si28.every((r) => r.a === 28));
    const siNat = selection.selectRows(rows, { z: 14, a: '0' });
    t.ok(siNat.length > 0 && siNat.every((r) => r.entry.nuclide.mass === 0), 'a = 0: natural targets');
    t.ok(selection.selectRows(rows, { z: 13, a: '27' }).some((r) => r.entry.nuclide.mass === 27));
    const order = selection.selectRows(rows, { z: 14 }).map((r) => ['EXP', 'TH', 'CUR', 'EVAL'].indexOf(r.code));
    t.deepEqual(order, [...order].sort((x, y) => x - y), 'in the order of the tables: by dataset code');
  });

  h.test('selection: the elements the element choices offer', async (t) => {
    const { rows } = await published();
    const sorted = (zs) => [...new Set(zs)].sort((x, y) => x - y);
    t.deepEqual(selection.elementsWithData(rows, ['EXP', 'CUR', 'EVAL']), sorted(rows.map((r) => r.z)), 'every element with data');
    for (const code of new Set(rows.map((r) => r.code))) {
      t.deepEqual(selection.elementsWithData(rows, new Set([code])), sorted(rows.filter((r) => r.code === code).map((r) => r.z)),
        `the elements with ${code} data (codes as a Set)`);
    }
    t.deepEqual(selection.elementsWithData(rows, []), [], 'no kinds: no elements');
    t.ok(!rows.some((r) => r.z === 118), 'Z = 118 has no data');
    const withOg = selection.elementsWithData(rows, ['EXP'], 118);
    t.deepEqual(withOg, sorted(rows.filter((r) => r.code === 'EXP').map((r) => r.z).concat(118)), 'the element shown, even without data');
    t.equal(withOg[withOg.length - 1], 118, 'in order of Z');
    const z = rows[0].z;
    t.deepEqual(selection.elementsWithData(rows, ['EXP', 'CUR', 'EVAL'], z), sorted(rows.map((r) => r.z)), 'an element with data only once');
  });

  h.test('selection: the CSV of a selection has exactly the rows shown, as published', async (t) => {
    const version = await published();
    const { csv } = await vector();
    const [header, ...records] = selection.parseCsv(csv);
    const published_ = new Map(records.map((r) => [r.fields[0], r.text]));
    const cases = [{}, { z: 14 }, { z: 14, a: '28' }, { z: 14, a: '0' }, { z: 13, a: '27' }, { ds: ['CUR'] },
      { z: 25, ds: ['EXP'] }, { z: 14, ds: ['EXP', 'EVAL'] }, { z: 92 }];
    for (const filters of cases) {
      const shown = selection.selectRows(version.rows, filters);
      const out = selection.parseCsv(selection.selectionCsv(csv, shown));
      t.equal(out[0].text, header.text, `${JSON.stringify(filters)} header:`);
      t.deepEqual(out.slice(1).map((r) => r.fields[0]), idsOf(shown), `${JSON.stringify(filters)}:`);
      for (const r of out.slice(1)) t.equal(r.text, published_.get(r.fields[0]), 'every record is copied as published');
    }
    t.equal(selection.selectionCsv(csv, []), `${header.text}\n`, 'nothing shown: the header only');
  });

  h.test('selection: CSV columns, unreported uncertainty, quoting', async (t) => {
    const version = await published();
    const { csv } = await vector();
    const columns = selection.parseCsv(csv)[0].fields;
    const shown = selection.selectRows(version.rows, { z: 25, ds: ['EXP'] });
    const text = selection.selectionCsv(csv, shown);
    t.deepEqual(selection.parseCsv(text)[0].fields, columns, 'the columns of the published file');
    const records = asRecords(text);
    const none = records.find((r) => r.key === 'extra');
    t.equal(none.value, '230.0', 'the value as written in the source');
    t.equal(none.observable, 'lifetime');
    for (const c of ['uncertainty', 'uncertaintyStatistical', 'uncertaintySystematic', 'lifetime_ns_unc',
      'capture_rate_us-1_unc', 'capture_probability_pct_unc']) {
      t.equal(none[c], '', `${c} of a value without uncertainty stays empty:`);
    }
    t.ok(none.lifetime_ns !== '' && none['capture_rate_us-1'] !== '', 'converted values are there');
    t.equal(none.comment, 'no uncertainty given, "test" entry\nsecond line');
    const given = records.find((r) => r !== none);
    t.equal(given.uncertainty, '4.5');

    // line ends CR LF, and broken input
    t.deepEqual(asRecords(selection.selectionCsv(csv.replace(/\n/g, '\r\n'), shown)).map((r) => r.datasetId), idsOf(shown));
    t.throws(() => selection.selectionCsv(csv, [{ entry: { datasetId: 'ffffffffffff' } }]), 'an entry missing from the CSV');
    t.throws(() => selection.selectionCsv('a,b\n1,2\n', shown), 'no datasetId column');
    t.throws(() => selection.selectionCsv(`${columns.join(',')}\n${none.datasetId},x\n`, shown), 'a record with too few fields');
    t.throws(() => selection.parseCsv('a,"b\n'), 'unterminated quote');
    t.deepEqual(selection.parseCsv('a,b\n"x\ry","1\n2"\n'),
      [{ fields: ['a', 'b'], text: 'a,b' }, { fields: ['x\ry', '1\n2'], text: '"x\ry","1\n2"' }], 'quoted CR and LF');
  });

  h.test('selection: the JSON of a selection', async (t) => {
    const version = await published();
    const shown = selection.selectRows(version.rows, { z: 14, ds: ['EXP', 'CUR'] });
    const filters = selection.describeFilters({ z: 14, a: '', ds: new Set(['CUR', 'EXP']) }, version.tables.elements);
    t.deepEqual(filters, { element: 'Si', z: 14, massNumber: null, datasetTypes: ['experiment', 'curated'] });
    const url = route.explorerPermalink(version.label, { z: 14, ds: 'EXP,CUR' });
    t.ok(url.endsWith('/explorer/?v=v1&z=14&ds=EXP%2CCUR'), url);
    const config = { paper: null, data: { title: 'muND: Muon Nuclear Data', author: 'muND Project Team' } };
    const cited = cite.citationTexts(config, { ...version.manifest, label: version.label }, url);
    const doc = selection.selectionJson({ version, rows: shown, filters, citation: cited, permalink: url, dataLicence: null });
    t.equal(doc.format, 'muND/selection/LT/1');
    t.equal(doc.version, '1.0.0');
    t.equal(doc.commit, version.manifest.commit);
    t.deepEqual(doc.citation, { paper: null, database: `muND Project Team, muND: Muon Nuclear Data, version 1.0.0 (2026), ${url}.` });
    t.equal(doc.permalink, url);
    t.equal(doc.dataLicence, null);
    t.deepEqual(doc.selection, { ...filters, entries: shown.length });
    t.deepEqual(Object.keys(doc.manifest), ['format', 'label', 'version', 'kind', 'commit', 'date', 'sublibraries', 'archive'],
      'the manifest without its list of files');
    const { bytes, sha256 } = version.manifest.files.find((f) => f.path === 'LT.json');
    t.deepEqual(doc.source, { path: 'data/v1/LT.json', bytes, sha256 });
    t.deepEqual(doc.data.map((e) => e.datasetId), idsOf(shown), 'the entries shown, as published');
    t.deepEqual(doc.meta.map((m) => m.id), ['4d2ed5c83736', '15fd4fea826c'], 'their metadata records');
    t.deepEqual(doc.bibliography.map((b) => b.id), ['DOI:10.1103/vl7z-rzp8', 'DOI:10.48550/arXiv.2501.05897'],
      'the references they and their metadata records cite that have an entry');

    const text = jsonfmt.stringify(doc);
    t.ok(text.includes('"uncertainties": [{"source": "total", "value": 0.0090}]'), 'numbers keep their written digits');
    const back = JSON.parse(text);
    t.deepEqual(back.data.map((e) => e.datasetId), idsOf(shown));
    t.equal(back.manifest.version, '1.0.0');

    const evaluated = selection.selectionJson({ version, rows: selection.selectRows(version.rows, { ds: ['EVAL'] }), filters });
    t.deepEqual(evaluated.bibliography.map((b) => b.id), ['DOI:10.1103/PhysRevC.111.034614']);
    t.equal(evaluated.citation, null);

    t.equal(selection.selectionName(version.manifest, filters), 'mund_LT_1.0.0_Si_EXP-CUR');
    t.equal(selection.selectionName(version.manifest, selection.describeFilters({}, version.tables.elements)), 'mund_LT_1.0.0_all');
    t.equal(selection.selectionName({ version: '1.0.0+2.gabcdef1' },
      selection.describeFilters({ z: 14, a: '0', ds: ['EVAL'] }, version.tables.elements)), 'mund_LT_1.0.0+2.gabcdef1_Si_nat_EVAL');
  });

  // -------------------------------------------------------------------- model
  const VERSIONS = {
    format: 'muND/versions/1',
    default: 'v1',
    versions: [
      { label: 'v1', version: '1.0.0', kind: 'release', commit: 'abc', date: '2026-11-16T12:00:00+09:00' },
      { label: 'latest', version: '1.0.0+2.gabcdef1', kind: 'development', commit: 'abcdef1234', date: '2026-11-17T12:00:00+09:00' },
    ],
  };

  h.test('model: the version in the address', async (t) => {
    for (const requested of [null, undefined, '']) {
      const r = model.resolveVersion(VERSIONS, requested);
      t.equal(r.label, 'v1', 'no version: the default one');
      t.equal(r.error, null);
    }
    t.equal(model.resolveVersion(VERSIONS, 'latest').entry.kind, 'development');
    for (const requested of ['v7', '1.0.0', 'LATEST']) {
      const r = model.resolveVersion(VERSIONS, requested);
      t.equal(r.label, null, `${requested}: nothing else in its place`);
      t.equal(r.entry, null);
      t.ok(r.error && r.error.includes(`“${requested}”`), `${requested}: an error naming it`);
    }
    t.ok(model.resolveVersion({ ...VERSIONS, default: 'v2' }, null).error, 'a default that does not exist');
    t.equal(model.checkManifest(VERSIONS.versions[0], { label: 'v1', version: '1.0.0' }).label, 'v1');
    t.throws(() => model.checkManifest(VERSIONS.versions[0], { label: 'latest', version: '1.0.0+2.gabcdef1' }));
    t.throws(() => model.checkManifest(VERSIONS.versions[0], { label: 'v1', version: '1.0.1' }));
    const [release, development] = VERSIONS.versions;
    t.equal(model.versionName(release, { newest: VERSIONS.default }), 'Version 1.0.0 (latest stable)');
    t.equal(model.versionName(release, { newest: 'v2' }), 'Version 1.0.0');
    t.equal(model.versionName(development, { newest: VERSIONS.default }), 'Development version 1.0.0+2.gabcdef1 (unstable)');
  });

  h.test('model: sub-libraries of a version', async (t) => {
    const { manifest, rows } = await published();
    t.equal(model.sublibraryTotal(manifest, 'LT'), rows.length);
    for (const s of ['XR', 'ES', 'BR']) t.equal(model.sublibraryTotal(manifest, s), 0, `${s}:`);
    t.equal(model.sublibraryTotal({ sublibraries: { LT: { status: 'planned', counts: { EXP: 3 } } } }, 'LT'), 0,
      'a sub-library that is not available');
    const { master, lt } = await vector();
    const format = 'muND/manifest/9';
    let error;
    try {
      model.buildVersion({ label: manifest.label, manifest: { ...manifest, format }, master, lt: jsonfmt.parse(lt) });
    } catch (e) {
      error = e;
    }
    t.ok(error?.message.includes(format), 'the error identifies the unsupported manifest format');
  });

  h.test('model: derived values whose original changed', async (t) => {
    const version = await published();
    const curated = version.byId.get('0430524aa904');
    t.deepEqual(curated.originals.map((o) => [o.id, o.changed, o.row.entry.datasetId]), [['e489422fdeb4', false, 'e489422fdeb4']]);
    t.equal(version.byId.get('ef8409832d42'), curated, 'a former identifier leads to the entry');
    t.equal(model.currentId(version, 'ef8409832d42'), '0430524aa904', 'a former identifier names the current DataID');
    t.equal(model.currentId(version, '0430524aa904'), '0430524aa904');
    t.equal(model.currentId(version, 'ffffffffffff'), '', 'an identifier not in the version');
    t.equal(model.currentId(version, ''), '');
    t.deepEqual(idsOf(version.usedBy.get('e489422fdeb4')), ['0430524aa904']);
    const edited = await published({
      edit: (data) => jsonfmt.setNumber(data.find((e) => e.datasetId === 'e489422fdeb4').observable.lifetime, 'value', '744.9'),
    });
    t.deepEqual(edited.byId.get('0430524aa904').originals.map((o) => o.changed), [true], 'a corrected original is flagged');
    t.ok(edited.byId.get('b15200d13c23').originals.every((o) => !o.changed), 'the others are not');
  });

  // -------------------------------------------------------------------- route
  h.test('route: citations and permalinks name the version', async (t) => {
    // the default version is shown: its label is still written out
    const shown = model.resolveVersion(VERSIONS, null);
    const link = route.explorerPermalink(shown.label, { z: 14, a: '', id: 'e489422fdeb4', q: null });
    t.ok(link.endsWith('/explorer/?v=v1&z=14&id=e489422fdeb4'), link);
    const data = { title: 'muND: Muon Nuclear Data', author: 'muND Project Team' };
    const release = (await published()).manifest;
    t.equal(cite.citationTexts({ data }, { ...release, label: 'v1' }, link).database,
      `muND Project Team, muND: Muon Nuclear Data, version 1.0.0 (2026), ${link}.`, 'an entry: the address of the entry');
    t.ok(route.explorerPermalink('v1', { a: '0' }).endsWith('/explorer/?v=v1&a=0'), 'mass number 0 is kept');
  });

  h.test('route: addresses of the pages', async (t) => {
    t.ok(route.pageUrl('explorer', { v: 'v1', z: 14, a: '', id: null }).endsWith('/explorer/?v=v1&z=14'), 'empty parameters are left out');
    t.ok(route.pageUrl('explorer', { z: 14, a: '0' }).endsWith('/explorer/?z=14&a=0'), 'mass number 0 is kept');
    t.ok(route.pageUrl('docs/data-format').endsWith('/docs/data-format/'));
    t.ok(route.pageUrl('').endsWith('/') && !route.pageUrl('').includes('?'), 'Home');
  });

  h.test('route: links built from the address keep a section anchor but not the skip target', (t) => {
    const inNode = typeof document === 'undefined';
    const originalUrl = inNode ? null : location.href;
    const at = (hash) => {
      if (inNode) globalThis.location = { pathname: '/explorer/', search: '?v=v1&z=14', hash };
      else history.replaceState(history.state, '', `/explorer/?v=v1&z=14${hash}`);
    };
    try {
      at('#main');
      t.equal(route.urlWith({ a: 28 }), '/explorer/?v=v1&z=14&a=28', 'the skip target is left out');
      t.equal(route.versionUrl('v2'), '/explorer/?v=v2&z=14');
      at('#citing');
      t.equal(route.urlWith({ z: null }), '/explorer/?v=v1#citing', 'a section anchor is kept');
    } finally {
      if (inNode) delete globalThis.location;
      else history.replaceState(history.state, '', originalUrl);
    }
  });
}
