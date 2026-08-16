/* eslint-disable no-bitwise -- the thing under test is a bitmask, and writing
   the expected values as decimal literals would be checking the arithmetic
   rather than the mapping. */

import test from "tape";

import {
  ALT,
  CTRL,
  type Hotkey,
  META,
  SHIFT,
  describeHotkey,
  hotkeyFromEvent,
  isBound,
  modifierMask,
  virtualKeyFor,
} from "../app/common/push-to-talk-key.ts";

const hotkey = (code: string, held: Partial<Hotkey> = {}): Hotkey => ({
  code,
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
  ...held,
});

test("virtual keys are the ones Windows names", (t) => {
  // Spot checks against the values in winuser.h, one per generated range, plus
  // the ones written out by hand that a typo would silently mis-bind.
  t.equal(virtualKeyFor("KeyA"), 0x41);
  t.equal(virtualKeyFor("KeyZ"), 0x5a);
  t.equal(virtualKeyFor("Digit0"), 0x30);
  t.equal(virtualKeyFor("Digit9"), 0x39);
  t.equal(virtualKeyFor("Numpad0"), 0x60);
  t.equal(virtualKeyFor("F1"), 0x70);
  t.equal(virtualKeyFor("F12"), 0x7b);
  t.equal(virtualKeyFor("F24"), 0x87);
  t.equal(virtualKeyFor("Space"), 0x20);
  t.equal(virtualKeyFor("CapsLock"), 0x14);

  // The sides are distinct keys to the hook, and the whole reason the stored
  // form is a physical code rather than a modifier flag.
  t.equal(virtualKeyFor("ControlLeft"), 0xa2);
  t.equal(virtualKeyFor("ControlRight"), 0xa3);
  t.equal(virtualKeyFor("AltLeft"), 0xa4);
  t.equal(virtualKeyFor("AltRight"), 0xa5);

  t.end();
});

test("a key with no virtual key is not bindable", (t) => {
  // Media keys, and anything a future DOM invents: no entry, no binding, and
  // nothing stored that would sit in the settings never firing.
  t.equal(virtualKeyFor("MediaPlayPause"), undefined);
  t.equal(virtualKeyFor(""), undefined);
  t.false(isBound(hotkey("")));
  t.false(isBound(hotkey("MediaPlayPause")));
  t.true(isBound(hotkey("KeyV", {ctrl: true})));

  t.end();
});

test("modifiers become the mask the hook compares", (t) => {
  t.equal(modifierMask(hotkey("KeyV")), 0);
  t.equal(modifierMask(hotkey("KeyV", {ctrl: true})), CTRL);
  t.equal(
    modifierMask(
      hotkey("KeyV", {ctrl: true, shift: true, alt: true, meta: true}),
    ),
    CTRL | SHIFT | ALT | META,
  );

  t.end();
});

test("a hotkey reads the way the rest of Windows prints one", (t) => {
  t.equal(describeHotkey(hotkey("KeyV")), "V");
  t.equal(describeHotkey(hotkey("F13")), "F13");
  t.equal(describeHotkey(hotkey("Space")), "Space");
  t.equal(describeHotkey(hotkey("Backquote")), "`");
  t.equal(describeHotkey(hotkey("Numpad5")), "Numpad 5");

  // Ctrl, Alt, Shift, Win, in that order whatever order they were pressed in.
  t.equal(
    describeHotkey(hotkey("KeyV", {shift: true, ctrl: true})),
    "Ctrl + Shift + V",
  );
  t.equal(
    describeHotkey(hotkey("KeyV", {meta: true, alt: true, ctrl: true})),
    "Ctrl + Alt + Win + V",
  );

  // Nothing chosen is nothing to print; the button says so in its own words.
  t.equal(describeHotkey(hotkey("")), "");

  t.end();
});

test("a modifier held alone is the key, not a requirement", (t) => {
  // Left alt reports itself as alt being down. Recording that as "alt must also
  // be held" would produce a binding that can never match, since the hook
  // discounts the watched key from the modifiers it checks.
  const alone = hotkeyFromEvent({
    code: "AltLeft",
    ctrlKey: false,
    shiftKey: false,
    altKey: true,
    metaKey: false,
  });
  t.deepEqual(alone, hotkey("AltLeft"));
  t.equal(describeHotkey(alone), "Left Alt");
  t.equal(modifierMask(alone), 0);

  t.end();
});

test("an ordinary key records the modifiers held with it", (t) => {
  const combination = hotkeyFromEvent({
    code: "KeyV",
    ctrlKey: true,
    shiftKey: false,
    altKey: true,
    metaKey: false,
  });
  t.deepEqual(combination, hotkey("KeyV", {ctrl: true, alt: true}));
  t.equal(modifierMask(combination), CTRL | ALT);

  t.end();
});
