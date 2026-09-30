// A small in-memory DOM that react-dom/client can mount into, for tests whose
// answer depends on React's commit order (autoFocus, layout effects, portals)
// and on where the browser leaves focus. It keeps only what those tests touch:
// elements, text, attributes, inline style, listeners, and focus, including
// the browser rule that focus falls to <body> when the focused element leaves
// the page. No layout and no event dispatch: a test drives state directly.
//
// installLiveDom() must run before react-dom/client is first imported, since
// React decides at load time whether it has a DOM.

const HTML = 'http://www.w3.org/1999/xhtml';
const FOCUSABLE = /^(BUTTON|INPUT|SELECT|TEXTAREA)$/;

function inlineStyle() {
  const values = new Map(), priorities = new Map();
  const api = {
    setProperty(name, value, priority = '') { values.set(name, String(value)); priorities.set(name, priority); },
    getPropertyValue(name) { return values.get(name) || ''; },
    getPropertyPriority(name) { return priorities.get(name) || ''; },
    removeProperty(name) { const was = values.get(name) || ''; values.delete(name); priorities.delete(name); return was; },
  };
  return new Proxy(api, {
    get(target, key) { return key in target ? target[key] : values.get(key) || ''; },
    set(_, key, value) { values.set(key, String(value)); return true; },
  });
}

class LiveNode {
  constructor(doc, nodeType, nodeName) {
    this.ownerDocument = doc;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] ?? null : null; }
  get previousSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) - 1] ?? null : null; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get isConnected() { const doc = this.ownerDocument ?? this; for (let n = this; n; n = n.parentNode) if (n === doc) return true; return false; }
  contains(other) { for (let n = other; n; n = n.parentNode) if (n === this) return true; return false; }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, ref) {
    if (child.nodeType === 11) { for (const c of [...child.childNodes]) this.insertBefore(c, ref); return child; }
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(child); else this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const at = this.childNodes.indexOf(child);
    if (at < 0) throw new Error('removeChild: not a child of this node');
    const doc = this.ownerDocument ?? this;
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    // The browser rule: the focused element left the page, focus is on <body>.
    if (doc.activeElement && child.contains(doc.activeElement)) doc.activeElement = doc.body;
    return child;
  }
  get nodeValue() { return this.nodeType === 3 || this.nodeType === 8 ? this.data : null; }
  set nodeValue(v) { if (this.nodeType === 3 || this.nodeType === 8) this.data = String(v); }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(c => c.textContent).join(''); }
  set textContent(v) {
    if (this.nodeType === 3) { this.data = String(v); return; }
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
}

class LiveElement extends LiveNode {
  constructor(doc, tag, namespaceURI) {
    super(doc, 1, namespaceURI === HTML ? tag.toUpperCase() : tag);
    this.tagName = this.nodeName;
    this.localName = tag;
    this.namespaceURI = namespaceURI;
    this.attrs = new Map();
    this.style = inlineStyle();
    this.listeners = [];
    this.onclick = null;
    this.scrollTop = 0; this.scrollLeft = 0; this.scrollHeight = 0;
    this.clientHeight = 0; this.clientWidth = 0; this.offsetHeight = 0;
  }
  get children() { return this.childNodes.filter(c => c.nodeType === 1); }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(v) { this.setAttribute('id', v); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  setAttributeNS(_ns, name, value) { this.setAttribute(name, value); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  removeAttributeNS(_ns, name) { this.removeAttribute(name); }
  addEventListener(type, fn) { this.listeners.push([type, fn]); }
  removeEventListener(type, fn) { this.listeners = this.listeners.filter(([t, f]) => t !== type || f !== fn); }
  getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; }
  /** Like a browser: only a connected, focusable element takes focus. */
  focus() {
    if (!this.isConnected || !(FOCUSABLE.test(this.tagName) || this.hasAttribute('tabindex'))) return;
    this.ownerDocument.activeElement = this;
  }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
}

class LiveDocument extends LiveNode {
  constructor() {
    super(null, 9, '#document');
    this.listeners = [];
    this.documentElement = this.createElement('html');
    this.appendChild(this.documentElement);
    this.head = this.documentElement.appendChild(this.createElement('head'));
    this.body = this.documentElement.appendChild(this.createElement('body'));
    this.activeElement = this.body;
  }
  createElement(tag) { return new LiveElement(this, tag, HTML); }
  createElementNS(ns, tag) { return new LiveElement(this, tag, ns); }
  createTextNode(text) { const n = new LiveNode(this, 3, '#text'); n.data = String(text); return n; }
  createComment(text) { const n = new LiveNode(this, 8, '#comment'); n.data = String(text); return n; }
  createDocumentFragment() { return new LiveNode(this, 11, '#document-fragment'); }
  addEventListener(type, fn) { this.listeners.push([type, fn]); }
  removeEventListener(type, fn) { this.listeners = this.listeners.filter(([t, f]) => t !== type || f !== fn); }
  /** Every element under `from` that `pred` accepts, in document order. */
  all(pred = () => true, from = this, out = []) {
    for (const c of from.childNodes) if (c.nodeType === 1) { if (pred(c)) out.push(c); this.all(pred, c, out); }
    return out;
  }
  getElementById(id) { return this.all(n => n.getAttribute('id') === id)[0] ?? null; }
}

/** A window and document on globalThis; returns them and a remove function. */
export function installLiveDom() {
  const doc = new LiveDocument();
  const timers = new Map();
  let next = 1;
  const listeners = [];
  const win = {
    document: doc, innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0,
    HTMLIFrameElement: class HTMLIFrameElement {},
    scrollTo() {},
    addEventListener(type, fn) { listeners.push([type, fn]); },
    removeEventListener() {},
    // Scheduled work (viewport tracking) never runs here: nothing is laid out.
    requestAnimationFrame(fn) { const id = next++; timers.set(id, fn); return id; },
    cancelAnimationFrame(id) { timers.delete(id); },
    setTimeout(fn) { const id = next++; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  win.top = win; win.self = win; win.window = win;
  doc.defaultView = win;
  const saved = { window: globalThis.window, document: globalThis.document };
  globalThis.window = win;
  globalThis.document = doc;
  return {
    win, doc,
    remove() {
      if (saved.window === undefined) delete globalThis.window; else globalThis.window = saved.window;
      if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    },
  };
}
