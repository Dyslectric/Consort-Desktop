import test from "tape";

import {
  parseHyprlandClients,
  parseParentProcessId,
  parseSwayTree,
  parseXpropClientList,
  parseXpropWindow,
  titlesByProcess,
} from "../app/main/window-title-parse.ts";

// Captured from `hyprctl -j clients`, cut to the keys that matter: two windows
// of one browser, a player, and an unmapped leftover.
//
// Held as the text these commands actually print, rather than as objects, both
// because that is what the parsers are given and because the keys are the
// compositors' own — `app_id` and `floating_nodes` below are sway's spelling
// and cannot be written in this codebase's.
const hyprland = `[
  {
    "address": "0x55d0e2a1b2c0",
    "mapped": true,
    "class": "firefox",
    "title": "Never Gonna Give You Up — Mozilla Firefox",
    "pid": 3412,
    "xwayland": false
  },
  {
    "address": "0x55d0e2a1d400",
    "mapped": true,
    "class": "firefox",
    "title": "Bug 1 — Bugzilla — Mozilla Firefox",
    "pid": 3412,
    "xwayland": false
  },
  {
    "address": "0x55d0e2a2f110",
    "mapped": true,
    "class": "mpv",
    "title": "some-track.opus",
    "pid": 4004,
    "xwayland": false
  },
  {
    "address": "0x55d0e2a30990",
    "mapped": false,
    "class": "steam",
    "title": "Steam",
    "pid": 5150,
    "xwayland": true
  }
]`;

test("hyprctl gives a title and an owner per window", (t) => {
  const toplevels = parseHyprlandClients(hyprland);
  t.deepEqual(
    toplevels,
    [
      {
        processId: "3412",
        title: "Never Gonna Give You Up — Mozilla Firefox",
      },
      {processId: "3412", title: "Bug 1 — Bugzilla — Mozilla Firefox"},
      {processId: "4004", title: "some-track.opus"},
    ],
    "every mapped window, with its pid as a string",
  );
  t.end();
});

test("an unmapped window is not a window", (t) => {
  // It is not on screen, and counting it would make its application look like
  // it had one more than it has — which is enough to lose the title.
  t.equal(
    parseHyprlandClients(hyprland).some(
      (toplevel) => toplevel.processId === "5150",
    ),
    false,
    "the unmapped entry is left out",
  );
  t.end();
});

// Captured from `swaymsg -t get_tree`: root, output, workspace, then the
// windows — one tiled, one floating.
const sway = `{
  "id": 1,
  "name": "root",
  "type": "root",
  "nodes": [
    {
      "id": 3,
      "name": "HDMI-A-1",
      "type": "output",
      "nodes": [
        {
          "id": 6,
          "name": "1",
          "type": "workspace",
          "nodes": [
            {
              "id": 9,
              "type": "con",
              "name": "Never Gonna Give You Up — Mozilla Firefox",
              "app_id": "firefox",
              "pid": 3412
            }
          ],
          "floating_nodes": [
            {
              "id": 11,
              "type": "floating_con",
              "name": "some-track.opus",
              "app_id": "mpv",
              "pid": 4004
            }
          ]
        }
      ],
      "floating_nodes": []
    }
  ]
}`;

test("swaymsg's tree is walked to the windows in it", (t) => {
  t.deepEqual(
    parseSwayTree(sway),
    [
      {
        processId: "3412",
        title: "Never Gonna Give You Up — Mozilla Firefox",
      },
      {processId: "4004", title: "some-track.opus"},
    ],
    "a tiled window and a floating one, and neither the output nor the " +
      "workspace, whose names would otherwise look just as much like windows",
  );
  t.end();
});

test("output no compositor would produce costs a title, not a throw", (t) => {
  // The list of applications is built out of this; a compositor answering
  // strangely must not be able to empty it.
  for (const output of [
    "",
    "not json at all",
    "{}",
    "[]",
    "null",
    JSON.stringify([{pid: "3412", title: "a pid as a string"}]),
    JSON.stringify([{pid: 0, title: "an unknown owner"}]),
    JSON.stringify([{pid: 3412}]),
    JSON.stringify([{pid: 3412, title: ""}]),
    JSON.stringify({nodes: "not a list"}),
  ]) {
    t.deepEqual(parseHyprlandClients(output), [], `hyprctl: ${output}`);
    t.deepEqual(parseSwayTree(output), [], `swaymsg: ${output}`);
  }

  t.end();
});

test("xprop's client list yields window ids", (t) => {
  t.deepEqual(
    parseXpropClientList(
      "_NET_CLIENT_LIST(WINDOW): window id # 0x1400003, 0x1600001, 0x1a00007\n",
    ),
    ["0x1400003", "0x1600001", "0x1a00007"],
    "split on the commas, trimmed",
  );

  t.deepEqual(
    parseXpropClientList("_NET_CLIENT_LIST:  not found.\n"),
    [],
    "a window manager that sets no client list has no windows to offer",
  );
  t.end();
});

test("xprop names one window and says whose it is", (t) => {
  t.deepEqual(
    parseXpropWindow(
      `_NET_WM_PID(CARDINAL) = 3412
_NET_WM_NAME(UTF8_STRING) = "Never Gonna Give You Up — Mozilla Firefox"
WM_NAME(STRING) = "Never Gonna Give You Up - Mozilla Firefox"
`,
    ),
    {processId: "3412", title: "Never Gonna Give You Up — Mozilla Firefox"},
    "_NET_WM_NAME wins, being the one that survives a non-English title",
  );

  t.deepEqual(
    parseXpropWindow(
      `_NET_WM_PID(CARDINAL) = 4004
_NET_WM_NAME:  not found.
WM_NAME(STRING) = "xterm"
`,
    ),
    {processId: "4004", title: "xterm"},
    "WM_NAME is read when an old application sets only that",
  );

  t.equal(
    parseXpropWindow('_NET_WM_NAME(UTF8_STRING) = "No owner"'),
    undefined,
    "a window with no pid cannot be matched to a stream, so it is dropped",
  );

  t.equal(
    parseXpropWindow("_NET_WM_PID(CARDINAL) = 4004\n_NET_WM_NAME:  not found."),
    undefined,
    "and neither can a window with no name be worth showing",
  );
  t.end();
});

test("xprop's escaping is undone", (t) => {
  t.equal(
    parseXpropWindow(
      String.raw`_NET_WM_PID(CARDINAL) = 3412
_NET_WM_NAME(UTF8_STRING) = "He said \"hello\", then C:\\ and a break\nhere"
`,
    )!.title,
    String.raw`He said "hello", then C:\ and a break here`,
    "quotes and backslashes come back, and a newline becomes a space rather " +
      "than breaking the single line it is drawn on",
  );
  t.end();
});

test("a process with two windows is not guessed at", (t) => {
  const titles = titlesByProcess(parseHyprlandClients(hyprland));
  t.equal(
    titles.has("3412"),
    false,
    "nothing here says which of the browser's windows is making the sound, " +
      "and the wrong title looks specific in a way the application name does not",
  );
  t.equal(titles.get("4004"), "some-track.opus", "one window, so no doubt");
  t.end();
});

test("the same window reported twice is still one window", (t) => {
  // An XWayland window comes back from the compositor and from xprop both.
  const titles = titlesByProcess([
    {processId: "5150", title: "Steam"},
    {processId: "5150", title: "Steam"},
  ]);
  t.equal(
    titles.get("5150"),
    "Steam",
    "identical titles from one process count once",
  );
  t.end();
});

test("a parent is read out of /proc/<pid>/stat", (t) => {
  t.equal(
    parseParentProcessId(
      "3600 (firefox) S 3412 3412 3412 0 -1 4194560 12345 0 0 0 55 12 0 0 20 0",
    ),
    "3412",
    "the field after the state",
  );

  t.equal(
    parseParentProcessId(
      "3601 (Isolated Web Co) S 3412 3412 3412 0 -1 4194560 999 0 0 0 3 1 0 0",
    ),
    "3412",
    "a name with spaces in it does not shift the count",
  );

  t.equal(
    parseParentProcessId("3602 (bash (deleted)) S 3412 3412 0 0 -1 4194560 1"),
    "3412",
    "nor does one with brackets of its own, which is why the last ')' is " +
      "what the fields are counted from",
  );

  t.equal(parseParentProcessId(""), undefined, "nothing to read");
  t.equal(
    parseParentProcessId("3603 (mpv"),
    undefined,
    "a read cut short is not a parent",
  );
  t.end();
});
