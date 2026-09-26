/**
 * The script that reads pages for Claude's browser use: the page's elements as an accessibility-style
 * tree with element references, a search for elements, the page's visible text, and what has focus.
 * It is plain JavaScript in a string, run in each frame, so nothing the build adds to functions gets
 * in its way. Elements keep their number for as long as the page lives; a new page (navigation) starts
 * a new document id, so references to an old page are found stale rather than pointing elsewhere.
 */

export interface ReaderNode {
  /** Depth in the tree. */
  d: number;
  /** The element's number in its document. */
  id?: number;
  role?: string;
  name?: string;
  props?: string[];
  /** A text node. */
  text?: string;
  /** An iframe or frame: its content is read from the frame itself. */
  frame?: boolean;
}

export type ReaderOp =
  | { kind: "read"; filter?: "interactive" | "all"; depth: number; root?: number }
  | { kind: "find"; query: string }
  | { kind: "text" }
  | { kind: "focus" }
  | { kind: "describe"; id: number }
  | { kind: "field"; id: number };

export interface ReaderResult {
  doc: string;
  nodes?: ReaderNode[];
  text?: string;
  missing?: boolean;
  focus?: { focused: boolean; frame?: boolean; none?: boolean; password?: boolean; editable?: boolean; role?: string | null; name?: string };
  field?: { tag: string; type: string; role: string | null; name: string; multiple: boolean; options: { value: string; text: string }[] };
  element?: { role: string | null; name: string };
}

const READER_SOURCE = String.raw`(op) => {
  const w = window;
  if (!w.__ebReader) {
    const doc = Math.random().toString(36).slice(2, 10);
    const refs = new Map();
    const ids = new WeakMap();
    let next = 1;
    const idOf = (el) => {
      let id = ids.get(el);
      if (id === undefined) { id = next++; ids.set(el, id); refs.set(id, el); }
      return id;
    };
    const element = (id) => { const el = refs.get(id); return el && el.isConnected ? el : null; };
    const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "BASE", "SVG"]);
    const INPUT_ROLES = { button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox", file: "button" };
    const INTERACTIVE = new Set(["link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "slider", "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "clickable", "iframe", "treeitem"]);
    const NAMED_BY_CONTENT = new Set(["link", "button", "heading", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "clickable", "cell", "gridcell", "columnheader", "rowheader", "listitem", "treeitem", "switch", "caption"]);
    const ACTIVE_SELECTOR = "a[href],button,input:not([type=hidden]),select,textarea,[onclick],[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=''],[contenteditable=true],iframe,frame";
    const inputType = (el) => (el.getAttribute("type") || "text").toLowerCase();

    const roleOf = (el) => {
      const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
      if (explicit && explicit !== "presentation" && explicit !== "none" && explicit !== "generic") return explicit;
      switch (el.tagName) {
        case "A": case "AREA": return el.hasAttribute("href") ? "link" : (el.hasAttribute("onclick") ? "clickable" : null);
        case "BUTTON": case "SUMMARY": return "button";
        case "INPUT": { const t = inputType(el); return t === "hidden" ? "hidden" : (INPUT_ROLES[t] || "textbox"); }
        case "TEXTAREA": return "textbox";
        case "SELECT": return el.multiple || el.size > 1 ? "listbox" : "combobox";
        case "OPTION": return "option";
        case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": return "heading";
        case "IMG": return clean(el.getAttribute("alt")) ? "img" : (el.hasAttribute("onclick") ? "clickable" : null);
        case "TABLE": return "table";
        case "TR": return "row";
        case "TH": return el.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
        case "TD": return "cell";
        case "UL": case "OL": return "list";
        case "LI": return "listitem";
        case "NAV": return "navigation";
        case "MAIN": return "main";
        case "FORM": return "form";
        case "FIELDSET": case "DETAILS": return "group";
        case "DIALOG": return "dialog";
        case "IFRAME": case "FRAME": return "iframe";
        case "PROGRESS": return "progressbar";
        case "LABEL": case "BODY": case "HTML": case "FRAMESET": return null;
      }
      if (el.isContentEditable && el.hasAttribute("contenteditable")) return "textbox";
      if (el.hasAttribute("onclick") || el.hasAttribute("onmousedown") || el.hasAttribute("ondblclick")) return "clickable";
      const tabindex = el.getAttribute("tabindex");
      if (tabindex !== null && Number(tabindex) >= 0) return "clickable";
      return null;
    };

    // Fields in old forms often sit in a table next to their label, without a <label>.
    const nearbyLabel = (el) => {
      const cell = el.closest("td,th");
      if (cell && cell.previousElementSibling) {
        const t = clean(cell.previousElementSibling.innerText || cell.previousElementSibling.textContent);
        if (t && t.length <= 80) return t.replace(/[:*]+$/, "").trim();
      }
      let prev = el.previousSibling;
      while (prev && prev.nodeType === 3 && !clean(prev.textContent)) prev = prev.previousSibling;
      if (prev) {
        const t = clean(prev.nodeType === 3 ? prev.textContent : (prev.innerText || prev.textContent));
        if (t && t.length <= 80 && !(prev.nodeType === 1 && prev.matches(ACTIVE_SELECTOR))) return t.replace(/[:*]+$/, "").trim();
      }
      return "";
    };

    const labelOf = (el) => {
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const t = by.split(/\s+/).map((id) => { const n = el.ownerDocument.getElementById(id); return n ? clean(n.textContent) : ""; }).join(" ").trim();
        if (t) return t;
      }
      const aria = clean(el.getAttribute("aria-label"));
      if (aria) return aria;
      if (el.labels && el.labels.length) {
        const t = Array.from(el.labels).map((l) => clean(l.innerText || l.textContent)).join(" ").trim();
        if (t) return t.replace(/[:*]+$/, "").trim();
      }
      return "";
    };

    const textOf = (el) => clean(el.innerText !== undefined ? el.innerText : el.textContent);

    const nameOf = (el, role) => {
      const labelled = labelOf(el);
      if (labelled) return labelled;
      const tag = el.tagName;
      if (tag === "INPUT") {
        const t = inputType(el);
        if (t === "button" || t === "submit" || t === "reset") return clean(el.value) || (t === "submit" ? "Submit" : t === "reset" ? "Reset" : "");
        if (t === "image") return clean(el.getAttribute("alt")) || clean(el.value) || "Submit";
        return clean(el.getAttribute("title")) || clean(el.getAttribute("placeholder")) || nearbyLabel(el) || clean(el.getAttribute("name")) || clean(el.id);
      }
      if (tag === "TEXTAREA" || tag === "SELECT") return clean(el.getAttribute("title")) || clean(el.getAttribute("placeholder")) || nearbyLabel(el) || clean(el.getAttribute("name")) || clean(el.id);
      if (tag === "IMG") return clean(el.getAttribute("alt")) || clean(el.getAttribute("title"));
      if (tag === "IFRAME" || tag === "FRAME") return clean(el.getAttribute("title")) || clean(el.getAttribute("name")) || clean(el.id);
      if (tag === "FIELDSET") { const legend = el.querySelector("legend"); return legend ? clean(legend.textContent) : ""; }
      if (tag === "TABLE") { const caption = el.querySelector("caption"); return caption ? clean(caption.textContent) : clean(el.getAttribute("summary")); }
      if (NAMED_BY_CONTENT.has(role)) {
        const t = textOf(el);
        if (t) return t.length > 150 ? t.slice(0, 150) + "…" : t;
        const img = el.querySelector("img[alt]");
        if (img && clean(img.getAttribute("alt"))) return clean(img.getAttribute("alt"));
        return clean(el.getAttribute("title")) || clean(el.value);
      }
      return clean(el.getAttribute("title"));
    };

    const quoteValue = (s) => String(s).slice(0, 200).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ");
    const shortHref = (el) => {
      try {
        const url = new URL(el.href, location.href);
        return url.origin === location.origin ? url.pathname + url.search : url.href.slice(0, 200);
      } catch (e) { return ""; }
    };

    const propsOf = (el, role) => {
      const p = [];
      const tag = el.tagName;
      if (role === "heading") p.push("level=" + (/^H[1-6]$/.test(tag) ? tag.slice(1) : (el.getAttribute("aria-level") || "2")));
      if (tag === "INPUT" || tag === "TEXTAREA") {
        const t = tag === "INPUT" ? inputType(el) : "textarea";
        if (t === "password") p.push("password");
        else if (t === "checkbox" || t === "radio") p.push(el.checked ? "checked" : "not checked");
        else if (t === "file") p.push("file input");
        else if (role === "textbox" || role === "searchbox" || role === "spinbutton" || role === "slider") { if (el.value) p.push('value="' + quoteValue(el.value) + '"'); }
        if (el.required) p.push("required");
        if (el.readOnly) p.push("readonly");
      }
      if (tag === "SELECT") {
        const selected = Array.from(el.selectedOptions || []).map((o) => clean(o.text)).join(", ");
        if (selected) p.push('value="' + quoteValue(selected) + '"');
      }
      if (tag === "OPTION" && el.selected) p.push("selected");
      if (el.disabled || el.getAttribute("aria-disabled") === "true") p.push("disabled");
      const expanded = el.getAttribute("aria-expanded");
      if (expanded) p.push(expanded === "true" ? "expanded" : "collapsed");
      const checked = el.getAttribute("aria-checked");
      if (checked && tag !== "INPUT") p.push(checked === "true" ? "checked" : "not checked");
      if (el.getAttribute("aria-selected") === "true" && tag !== "OPTION") p.push("selected");
      if (role === "link") {
        const raw = el.getAttribute("href") || "";
        if (raw && raw !== "#" && !/^javascript:/i.test(raw)) { const h = shortHref(el); if (h) p.push('href="' + quoteValue(h) + '"'); }
      }
      return p;
    };

    const boxed = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) return r;
      return null;
    };
    const shown = (el) => {
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        return getComputedStyle(el).display === "contents";
      }
      return true;
    };
    const inView = (r) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    const textInView = (node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = range.getClientRects();
      for (const r of rects) if (r.width > 0 && inView(r)) return true;
      return false;
    };
    const pointerLike = (el) => {
      if (!el.parentElement) return false;
      try { return getComputedStyle(el).cursor === "pointer" && getComputedStyle(el.parentElement).cursor !== "pointer"; } catch (e) { return false; }
    };

    const walk = (parent, depth, out, o) => {
      const kids = parent.shadowRoot ? Array.from(parent.shadowRoot.childNodes).concat(Array.from(parent.childNodes)) : parent.childNodes;
      for (const node of kids) {
        if (out.length >= o.max) return;
        if (node.nodeType === 3) {
          if (o.interactive || depth >= o.depth) continue;
          const t = clean(node.textContent);
          if (!t) continue;
          if (!o.all && !textInView(node)) continue;
          out.push({ d: depth, text: t.length > 300 ? t.slice(0, 300) + "…" : t });
          continue;
        }
        if (node.nodeType !== 1) continue;
        const el = node;
        if (SKIP.has(el.tagName.toUpperCase())) continue;
        let role = roleOf(el);
        if (role === "hidden" || !shown(el)) continue;
        const box = boxed(el);
        if (!box && el.tagName !== "OPTION" && getComputedStyle(el).display !== "contents") continue;
        if (box && !o.all && !inView(box) && el.tagName !== "OPTION") continue;
        if (!role && pointerLike(el) && !el.querySelector(ACTIVE_SELECTOR)) role = "clickable";
        if (role === "iframe") {
          if (depth < o.depth) out.push({ d: o.interactive ? 0 : depth, id: idOf(el), role, name: nameOf(el, role), props: [], frame: true });
          continue;
        }
        if (!role || (o.interactive && !INTERACTIVE.has(role))) { walk(el, depth, out, o); continue; }
        if (depth >= o.depth) continue;
        const hasActive = el.querySelector(ACTIVE_SELECTOR) !== null;
        const leaf = el.tagName !== "SELECT" && NAMED_BY_CONTENT.has(role) && (!hasActive || role === "link" || role === "button") && textOf(el).length <= 150;
        const container = NAMED_BY_CONTENT.has(role) && !leaf;
        out.push({ d: o.interactive ? 0 : depth, id: idOf(el), role, name: container ? "" : nameOf(el, role), props: propsOf(el, role) });
        if (el.tagName === "SELECT") {
          let n = 0;
          for (const option of el.options) {
            if (n++ >= 50 || out.length >= o.max) break;
            out.push({ d: o.interactive ? 1 : depth + 1, id: idOf(option), role: "option", name: clean(option.text) || clean(option.value), props: option.selected ? ["selected"] : [] });
          }
          continue;
        }
        if (!leaf) walk(el, depth + 1, out, o);
      }
    };

    const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").toLowerCase();
    const SYNONYMS = {
      field: ["textbox", "searchbox", "combobox", "spinbutton"], box: ["textbox", "searchbox", "combobox", "checkbox"], input: ["textbox", "searchbox", "combobox", "spinbutton"],
      textbox: ["textbox", "searchbox"], text: ["textbox"], search: ["searchbox", "textbox"], button: ["button", "clickable"], btn: ["button"], link: ["link"],
      dropdown: ["combobox", "listbox"], select: ["combobox", "listbox"], list: ["listbox", "list"], menu: ["menuitem", "combobox"], checkbox: ["checkbox"],
      check: ["checkbox"], radio: ["radio"], option: ["option", "radio"], tab: ["tab"], table: ["table"], row: ["row"], cell: ["cell"], heading: ["heading"],
      title: ["heading"], image: ["img"], picture: ["img"], icon: ["img", "clickable"], frame: ["iframe"],
    };
    const STOP = new Set(["the", "a", "an", "to", "of", "for", "in", "on", "with", "and", "or", "that", "this", "which"]);

    const find = (query) => {
      const words = norm(query).split(/[^a-z0-9ğüşöç]+/).filter((x) => x && !STOP.has(x));
      const wanted = new Set();
      const content = [];
      for (const word of words) { if (SYNONYMS[word]) SYNONYMS[word].forEach((r) => wanted.add(r)); else content.push(word); }
      const scored = [];
      const all = document.querySelectorAll("*");
      for (const el of all) {
        if (SKIP.has(el.tagName.toUpperCase())) continue;
        let role = roleOf(el);
        if (!role || role === "hidden") continue;
        if (!shown(el) || (!boxed(el) && el.tagName !== "OPTION")) continue;
        const name = nameOf(el, role);
        const hay = norm([name, el.getAttribute("placeholder"), el.getAttribute("title"), el.getAttribute("name"), el.id, el.getAttribute("aria-label")].join(" "));
        const nameNorm = norm(name);
        let score = 0;
        let matched = 0;
        for (const word of content) {
          if (nameNorm.includes(word)) { score += 3; matched++; }
          else if (hay.includes(word)) { score += 1; matched++; }
        }
        if (wanted.has(role)) score += 2;
        if (content.length ? matched === 0 : !wanted.has(role)) continue;
        if (score > 0) scored.push({ score, el, role, name });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 20).map((s) => ({ d: 0, id: idOf(s.el), role: s.role, name: s.name, props: propsOf(s.el, s.role) }));
    };

    const pageText = () => {
      const main = document.querySelector("main, [role=main]");
      const root = main && textOf(main).length > 200 ? main : document.body;
      if (!root) return "";
      return String(root.innerText || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    };

    const focus = () => {
      if (!document.hasFocus()) return { focused: false };
      let el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return { focused: true, none: true };
      while (el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") return { focused: true, frame: true };
      const role = roleOf(el);
      return { focused: true, password: el.tagName === "INPUT" && inputType(el) === "password", editable: el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable, role, name: nameOf(el, role) };
    };

    const run = (o) => {
      if (o.kind === "read") {
        const out = [];
        const opts = { interactive: o.filter === "interactive", all: o.filter === "all", depth: Math.max(1, o.depth || 15), max: 4000 };
        if (o.root !== undefined) {
          const root = element(o.root);
          if (!root) return { doc, missing: true };
          const role = roleOf(root);
          if (role && role !== "hidden") { out.push({ d: 0, id: idOf(root), role, name: nameOf(root, role), props: propsOf(root, role) }); walk(root, 1, out, opts); }
          else walk(root, 0, out, opts);
        } else if (document.body) {
          walk(document.body.tagName === "FRAMESET" ? document.documentElement : document.body, 0, out, opts);
        }
        return { doc, nodes: out };
      }
      if (o.kind === "find") return { doc, nodes: find(o.query) };
      if (o.kind === "text") return { doc, text: pageText() };
      if (o.kind === "focus") return { doc, focus: focus() };
      const el = element(o.id);
      if (!el) return { doc, missing: true };
      const role = roleOf(el);
      if (o.kind === "describe") return { doc, element: { role, name: nameOf(el, role) } };
      if (o.kind === "field") {
        const options = el.tagName === "SELECT" ? Array.from(el.options).map((x) => ({ value: x.value, text: clean(x.text) })) : [];
        return { doc, field: { tag: el.tagName, type: el.tagName === "INPUT" ? inputType(el) : "", role, name: nameOf(el, role), multiple: Boolean(el.multiple), options } };
      }
      return { doc };
    };

    w.__ebReader = { doc, idOf, element, run };
  }
  return w.__ebReader.run(op);
}`;

/** The reader as a function Playwright can send to a frame (built from source text, untouched by the build). */
export const readerFunction = new Function(`return (${READER_SOURCE})`)() as (op: ReaderOp) => ReaderResult;

/** The element a reference points at in its document, or null when the page has moved on. */
export function elementExpression(doc: string, id: number): string {
  return `window.__ebReader && window.__ebReader.doc === ${JSON.stringify(doc)} ? window.__ebReader.element(${Number(id)}) : null`;
}

/** An element's number in its document (the reader installed first): for matching frames to their element. */
export const elementIdFunction = new Function(
  "return (el) => { if (!window.__ebReader) return null; return { doc: window.__ebReader.doc, id: window.__ebReader.idOf(el) }; }",
)() as (el: unknown) => { doc: string; id: number } | null;
