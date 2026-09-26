/**
 * Key names as Claude writes them ("Return", "ctrl+s", "alt+Tab", "Page_Down", "Backspace Backspace") in
 * Playwright's names ("Enter", "Control", "PageDown").
 */

const NAMES: Record<string, string> = {
  return: "Enter",
  enter: "Enter",
  kp_enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  page_up: "PageUp",
  pageup: "PageUp",
  prior: "PageUp",
  page_down: "PageDown",
  pagedown: "PageDown",
  next: "PageDown",
  up: "ArrowUp",
  arrowup: "ArrowUp",
  down: "ArrowDown",
  arrowdown: "ArrowDown",
  left: "ArrowLeft",
  arrowleft: "ArrowLeft",
  right: "ArrowRight",
  arrowright: "ArrowRight",
  space: "Space",
  ctrl: "Control",
  control: "Control",
  control_l: "Control",
  control_r: "Control",
  shift: "Shift",
  shift_l: "Shift",
  shift_r: "Shift",
  alt: "Alt",
  alt_l: "Alt",
  alt_r: "Alt",
  option: "Alt",
  super: "Meta",
  super_l: "Meta",
  super_r: "Meta",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  win: "Meta",
  windows: "Meta",
  capslock: "CapsLock",
  caps_lock: "CapsLock",
  numlock: "NumLock",
  printscreen: "PrintScreen",
  print: "PrintScreen",
  pause: "Pause",
  contextmenu: "ContextMenu",
  menu: "ContextMenu",
  minus: "-",
  plus: "+",
  equal: "=",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  apostrophe: "'",
  grave: "`",
  bracketleft: "[",
  bracketright: "]",
};

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta"]);

/** One key's Playwright name; throws for names it doesn't know. */
export function keyName(raw: string): string {
  const name = raw.trim();
  if (name.length === 1) return name;
  const known = NAMES[name.toLowerCase()];
  if (known) return known;
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(name);
  if (fn) return `F${fn[1]}`;
  if (/^(Key[A-Z]|Digit[0-9]|Numpad[0-9A-Za-z]+|Arrow(Up|Down|Left|Right)|Page(Up|Down))$/.test(name)) return name;
  throw new Error(`Unknown key "${raw}"`);
}

/** "ctrl+shift+t" → ["Control", "Shift", "t"]; "ctrl++" → ["Control", "+"]. */
export function chord(text: string): string[] {
  const value = text.trim();
  if (value === "+") return ["+"];
  const plusKey = value.endsWith("++");
  const parts = (plusKey ? value.slice(0, -2) : value).split("+").filter((p) => p !== "");
  const keys = parts.map(keyName);
  if (plusKey) keys.push("+");
  if (!keys.length) throw new Error(`No key in "${text}"`);
  return keys;
}

/** A key, a chord, or a space-separated sequence of them ("Backspace Backspace"). */
export function keySequence(text: string): string[][] {
  const value = text.trim();
  if (value === "" && text.includes(" ")) return [["Space"]];
  return value.split(/\s+/).map(chord);
}

/** Modifier names held during a click or scroll ("shift", "ctrl+shift"). */
export function modifierKeys(text: unknown): string[] {
  if (typeof text !== "string" || !text.trim()) return [];
  const keys = chord(text);
  const bad = keys.filter((k) => !MODIFIERS.has(k));
  if (bad.length) throw new Error(`"${text}" is not a modifier (use shift, ctrl, alt or super)`);
  return keys;
}

export function isModifier(key: string): boolean {
  return MODIFIERS.has(key);
}
