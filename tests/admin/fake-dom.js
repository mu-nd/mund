// The DOM operations used to build and exercise the editor controls in Node.
class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.events = {};
    this.dataset = {};
    this.classList = { remove() {}, toggle() {} };
    this.value = '';
    this.isConnected = true;
  }

  removeAttribute(key) { delete this[key]; }
  focus() {}
  remove() {}
  appendChild(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(key, fn) { (this.events[key] ||= []).push(fn); }
  async fire(key) { for (const fn of this.events[key] || []) await fn({ target: this }); }
  find(match) {
    if (match(this)) return this;
    for (const child of this.children) {
      const found = child.find(match);
      if (found) return found;
    }
  }
}

export async function withDom(fn) {
  const doc = globalThis.document;
  const node = globalThis.Node;
  globalThis.Node = Element;
  globalThis.document = { createElement: (tag) => new Element(tag),
    createTextNode: (text) => Object.assign(new Element('#text'), { textContent: text }) };
  try { await fn(); } finally {
    if (doc === undefined) delete globalThis.document; else globalThis.document = doc;
    if (node === undefined) delete globalThis.Node; else globalThis.Node = node;
  }
}
