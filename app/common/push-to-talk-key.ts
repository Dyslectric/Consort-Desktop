// The push-to-talk key, in the two dialects it has to be spoken in.
//
// A key is chosen in the preferences window, where the only name for it is a
// DOM `KeyboardEvent.code`, and watched by a Windows keyboard hook, where the
// only name for it is a virtual-key code. Neither side can produce the other's,
// so the translation lives here — with the settings that store it, rather than
// in either end that reads it.
//
// `code` is the stored form on purpose. It names the *physical* key regardless
// of layout, which is what a hook reports and what somebody choosing a key to
// hold means: the key next to the space bar, not whatever letter that key types
// under the layout that happened to be active when they chose it.

/** A physical key, with the modifiers that have to be held with it. */
export type Hotkey = {
  /** A DOM `KeyboardEvent.code`. Empty means no key has been chosen. */
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
};

export const NO_HOTKEY: Hotkey = {
  code: "",
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
};

// The modifier bits, as the native hook counts them. Both sides of this number
// have to agree and only one of them is TypeScript, so it is written down in
// native/src/hotkey-win.cc as well; changing one without the other is a hotkey
// that never matches.
export const CTRL = 1;
export const SHIFT = 2;
export const ALT = 4;
export const META = 8;

/**
 Windows virtual-key codes, by the physical key the DOM calls them.

 Only keys somebody might plausibly hold to talk, which is nearly all of them —
 the notable absence is the media and browser keys, which no keyboard agrees
 about and which Windows already spends elsewhere.

 The left and right modifiers are separate entries because the hook reports them
 separately: holding right alt and having bound left alt is a key that does
 nothing, and a table that flattened the pair would make that impossible to say.
 */
const virtualKeys = new Map<string, number>([
  ["Backspace", 0x08],
  ["Tab", 0x09],
  ["Enter", 0x0d],
  ["Pause", 0x13],
  ["CapsLock", 0x14],
  ["Escape", 0x1b],
  ["Space", 0x20],
  ["PageUp", 0x21],
  ["PageDown", 0x22],
  ["End", 0x23],
  ["Home", 0x24],
  ["ArrowLeft", 0x25],
  ["ArrowUp", 0x26],
  ["ArrowRight", 0x27],
  ["ArrowDown", 0x28],
  ["PrintScreen", 0x2c],
  ["Insert", 0x2d],
  ["Delete", 0x2e],
  ["MetaLeft", 0x5b],
  ["MetaRight", 0x5c],
  ["ContextMenu", 0x5d],
  ["NumpadMultiply", 0x6a],
  ["NumpadAdd", 0x6b],
  ["NumpadSubtract", 0x6d],
  ["NumpadDecimal", 0x6e],
  ["NumpadDivide", 0x6f],
  ["NumLock", 0x90],
  ["ScrollLock", 0x91],
  ["ShiftLeft", 0xa0],
  ["ShiftRight", 0xa1],
  ["ControlLeft", 0xa2],
  ["ControlRight", 0xa3],
  ["AltLeft", 0xa4],
  ["AltRight", 0xa5],
  ["Semicolon", 0xba],
  ["Equal", 0xbb],
  ["Comma", 0xbc],
  ["Minus", 0xbd],
  ["Period", 0xbe],
  ["Slash", 0xbf],
  ["Backquote", 0xc0],
  ["BracketLeft", 0xdb],
  ["Backslash", 0xdc],
  ["BracketRight", 0xdd],
  ["Quote", 0xde],
  ["IntlBackslash", 0xe2],
  // The numpad's enter is the same virtual key as the main one, distinguished
  // only by an extended-key flag the hook does not pass on. Bound here so that
  // choosing it does something; what it does is what Enter does.
  ["NumpadEnter", 0x0d],
]);

for (let index = 0; index < 26; index += 1) {
  virtualKeys.set(`Key${String.fromCodePoint(65 + index)}`, 0x41 + index);
}

for (let digit = 0; digit <= 9; digit += 1) {
  virtualKeys.set(`Digit${digit}`, 0x30 + digit);
  virtualKeys.set(`Numpad${digit}`, 0x60 + digit);
}

// Through F24, not F12. The keys past the twelfth are the best push-to-talk
// keys there are — nothing else on the machine claims them, and a keyboard with
// a macro layer can send them — and they cost one line to support.
for (let number = 1; number <= 24; number += 1) {
  virtualKeys.set(`F${number}`, 0x6f + number);
}

/**
 The Windows virtual-key code for a physical key, or undefined for one that
 cannot be watched.

 Undefined is not a failure to be reported: it is a key the hook has no name
 for, and the preferences window declines to store it rather than saving a
 binding that would never fire.
 */
export function virtualKeyFor(code: string): number | undefined {
  return virtualKeys.get(code);
}

/** The modifiers of a hotkey, as the bitmask the native side compares against. */
export function modifierMask(hotkey: Hotkey): number {
  /* eslint-disable no-bitwise -- a bitmask is the point: the hook compares this
     with & against the modifiers actually held, and four booleans over IPC
     would be four things to keep in step instead of one. */
  return (
    (hotkey.ctrl ? CTRL : 0) |
    (hotkey.shift ? SHIFT : 0) |
    (hotkey.alt ? ALT : 0) |
    (hotkey.meta ? META : 0)
  );
  /* eslint-enable no-bitwise */
}

/** Whether a hotkey names a key this machine could actually watch. */
export function isBound(hotkey: Hotkey): boolean {
  return virtualKeyFor(hotkey.code) !== undefined;
}

const keyLabels = new Map<string, string>([
  ["ArrowDown", "Down"],
  ["ArrowLeft", "Left"],
  ["ArrowRight", "Right"],
  ["ArrowUp", "Up"],
  ["AltLeft", "Left Alt"],
  ["AltRight", "Right Alt"],
  ["Backquote", "`"],
  ["Backslash", "\\"],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Comma", ","],
  ["ContextMenu", "Menu"],
  ["ControlLeft", "Left Ctrl"],
  ["ControlRight", "Right Ctrl"],
  ["Equal", "="],
  ["IntlBackslash", "\\"],
  ["MetaLeft", "Left Win"],
  ["MetaRight", "Right Win"],
  ["Minus", "-"],
  ["NumpadAdd", "Numpad +"],
  ["NumpadDecimal", "Numpad ."],
  ["NumpadDivide", "Numpad /"],
  ["NumpadEnter", "Numpad Enter"],
  ["NumpadMultiply", "Numpad *"],
  ["NumpadSubtract", "Numpad -"],
  ["Period", "."],
  ["Quote", "'"],
  ["Semicolon", ";"],
  ["ShiftLeft", "Left Shift"],
  ["ShiftRight", "Right Shift"],
  ["Slash", "/"],
]);

/** What one physical key is called, on screen. */
export function describeKey(code: string): string {
  const named = keyLabels.get(code);
  if (named !== undefined) {
    return named;
  }

  const letter = /^Key(?<letter>[A-Z])$/v.exec(code)?.groups?.letter;
  if (letter !== undefined) {
    return letter;
  }

  const digit = /^Digit(?<digit>\d)$/v.exec(code)?.groups?.digit;
  if (digit !== undefined) {
    return digit;
  }

  const numpad = /^Numpad(?<digit>\d)$/v.exec(code)?.groups?.digit;
  if (numpad !== undefined) {
    return `Numpad ${numpad}`;
  }

  // Everything else — the function keys, Space, Home, and any code this table
  // has not thought about — reads well enough as itself.
  return code;
}

/**
 A hotkey as it appears on the button that sets it.

 Ctrl, Alt, Shift, Win: Windows' own order, which is the order these are printed
 in everywhere else on the machine.

 A modifier bound as the key itself prints once rather than twice — holding left
 alt is "Left Alt", not "Alt + Left Alt" — because the hook counts the key it is
 watching as the key, never as one of the modifiers that must accompany it.
 */
export function describeHotkey(hotkey: Hotkey): string {
  if (hotkey.code === "") {
    return "";
  }

  const parts = [];
  if (hotkey.ctrl) {
    parts.push("Ctrl");
  }

  if (hotkey.alt) {
    parts.push("Alt");
  }

  if (hotkey.shift) {
    parts.push("Shift");
  }

  if (hotkey.meta) {
    parts.push("Win");
  }

  parts.push(describeKey(hotkey.code));
  return parts.join(" + ");
}

/**
 The hotkey a key press describes, as the preferences window records it.

 A modifier pressed on its own is the key, with nothing else required: it is the
 commonest push-to-talk binding there is, and reading its own held-ness as a
 requirement would make it a key that can never match.
 */
export function hotkeyFromEvent(event: {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): Hotkey {
  const modifier = /^(?:Control|Shift|Alt|Meta)(?:Left|Right)$/v.test(
    event.code,
  );

  return {
    code: event.code,
    ctrl: !modifier && event.ctrlKey,
    shift: !modifier && event.shiftKey,
    alt: !modifier && event.altKey,
    meta: !modifier && event.metaKey,
  };
}
