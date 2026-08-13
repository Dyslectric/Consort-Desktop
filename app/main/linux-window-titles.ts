import {execFile} from "node:child_process";
import {readFile} from "node:fs/promises";
import process from "node:process";

import {
  type Toplevel,
  parseHyprlandClients,
  parseParentProcessId,
  parseSwayTree,
  parseXpropClientList,
  parseXpropWindow,
  titlesByProcess,
} from "./window-title-parse.ts";

// Naming an audio stream after the window making it.
//
// PulseAudio knows nothing about windows. A sink input carries the application
// name, the binary and what is playing, so the list of things to share reads
// "Firefox, Firefox, mpv" — the classes, not what is on screen. The title has
// to come from the compositor instead, matched to the stream by process id.
//
// Whether the compositor will say is entirely up to the compositor:
//
//   Hyprland   `hyprctl -j clients`     — pid and title, in one call.
//   sway       `swaymsg -t get_tree`    — the same, down a tree.
//   X11        `xprop`                  — via _NET_CLIENT_LIST, and it still
//                                         works for XWayland windows inside a
//                                         Wayland session, which is where a
//                                         good few applications still live.
//
// and two large desktops will not:
//
//   GNOME  `org.gnome.Shell.Introspect.GetWindows` is the interface for this
//          and is allowlisted to the GTK portal; anything else asking is
//          refused. It has no pid in its reply either, so it would not be
//          enough on its own even if it answered. There is no other route
//          without a shell extension, so GNOME keeps the application names.
//
//   KDE    KWin's scripting interface can read every window's caption and pid,
//          but a script has no way to return a value: it runs inside KWin, and
//          gets data out only by calling a D-Bus service, which this app would
//          have to own a name on to receive. Not worth a native dependency for
//          a label, so KDE keeps the application names too.
//
// Nothing here is required to work. Every failure — a missing tool, a desktop
// that says no, a stream whose process has gone — ends as "no title", and the
// caller falls back to the name PulseAudio gave it.

const QUERY_TIMEOUT_MS = 2000;

// Unlike `pactl`, a failure here is the ordinary case: `swaymsg` is not
// installed on most machines and is not expected to be, so a command that is
// missing or unhappy is reported as no output rather than as an error.
async function run(
  command: string,
  ...arguments_: string[]
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    execFile(
      command,
      arguments_,
      {timeout: QUERY_TIMEOUT_MS},
      (error, stdout) => {
        resolve(error === null ? stdout : undefined);
      },
    );
  });
}

// Each compositor is asked only when its session says it is there. Spawning all
// of them everywhere and watching two fail is a poor way to detect a desktop,
// and it is a poor way to spend the moment before a picker opens.
async function hyprlandToplevels(): Promise<Toplevel[]> {
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE === undefined) {
    return [];
  }

  const output = await run("hyprctl", "-j", "clients");
  return output === undefined ? [] : parseHyprlandClients(output);
}

async function swayToplevels(): Promise<Toplevel[]> {
  if (process.env.SWAYSOCK === undefined) {
    return [];
  }

  const output = await run("swaymsg", "-t", "get_tree", "-r");
  return output === undefined ? [] : parseSwayTree(output);
}

async function x11Toplevels(): Promise<Toplevel[]> {
  if (process.env.DISPLAY === undefined) {
    return [];
  }

  const root = await run("xprop", "-root", "_NET_CLIENT_LIST");
  if (root === undefined) {
    return [];
  }

  // One call per window, together rather than in turn: there are rarely more
  // than a dozen and they do not depend on each other.
  const windows = await Promise.all(
    parseXpropClientList(root).map(async (id) => {
      const output = await run(
        "xprop",
        "-id",
        id,
        "_NET_WM_PID",
        "_NET_WM_NAME",
        "WM_NAME",
      );
      return output === undefined ? undefined : parseXpropWindow(output);
    }),
  );
  return windows.filter((window) => window !== undefined);
}

/**
 Every window title this desktop is willing to give, by the process that owns
 it. Empty where it will give none, which is not an error.

 Read afresh each time. Titles are the most changeable thing on a desktop, and
 a cached one would name a stream after whatever its window said a while ago.
 */
export async function readWindowTitles(): Promise<ReadonlyMap<string, string>> {
  if (process.platform !== "linux") {
    return new Map();
  }

  const found = await Promise.all([
    hyprlandToplevels(),
    swayToplevels(),
    x11Toplevels(),
  ]);
  return titlesByProcess(found.flat());
}

async function readProcess(
  processId: string,
  file: string,
): Promise<string | undefined> {
  try {
    return await readFile(`/proc/${processId}/${file}`, "utf8");
  } catch {
    // The process ended between being listed and being asked about, or this is
    // not Linux at all.
    return undefined;
  }
}

// A browser plays its audio from a process of its own — Chromium's audio
// service, one of Firefox's children — and that process has no window. Its
// parent does.
//
// Only ancestors running the same executable are followed, which is what makes
// this safe: it is the one shape a multi-process application has. Following any
// parent would walk out of an application launched from a terminal and into the
// terminal itself, and label mpv with "dave@box: ~" — a title that is real,
// and about the wrong window entirely.
const MAX_ANCESTORS = 3;

async function sameExecutableAncestors(
  processId: string,
  executable: string,
  remaining: number,
): Promise<string[]> {
  if (remaining === 0) {
    return [];
  }

  const parent = await readProcess(processId, "stat");
  const parentId =
    parent === undefined ? undefined : parseParentProcessId(parent);
  // Init is pid 1, and pid 0 is what a process whose parent has gone reports.
  if (parentId === undefined || ["0", "1"].includes(parentId)) {
    return [];
  }

  if ((await readProcess(parentId, "comm"))?.trim() !== executable) {
    return [];
  }

  return [
    parentId,
    ...(await sameExecutableAncestors(parentId, executable, remaining - 1)),
  ];
}

/** The title of the window behind a stream, if this desktop said which. */
export async function titleForProcess(
  titles: ReadonlyMap<string, string>,
  processId: string,
): Promise<string | undefined> {
  // On a desktop that tells us nothing there is no point reading /proc at all.
  if (titles.size === 0 || processId === "") {
    return undefined;
  }

  const own = titles.get(processId);
  if (own !== undefined) {
    return own;
  }

  const executable = (await readProcess(processId, "comm"))?.trim();
  if (executable === undefined || executable === "") {
    return undefined;
  }

  for (const ancestor of await sameExecutableAncestors(
    processId,
    executable,
    MAX_ANCESTORS,
  )) {
    const title = titles.get(ancestor);
    if (title !== undefined) {
      return title;
    }
  }

  return undefined;
}
