// Parsing what a compositor says about its windows.
//
// Its own file, with no child_process in it, for the same reason pactl-parse.ts
// is one: the formats can then be tested against captured output, on a machine
// with no compositor anywhere near it.
//
// Every function here is total. A desktop that answers with something
// unexpected — a version with different keys, an error printed as JSON, a read
// cut short — must cost the caller a window title, not the list of applications
// it was building.

export type Toplevel = {
  /** The process the compositor says the window belongs to. */
  processId: string;
  title: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

function toplevel(processId: unknown, title: unknown): Toplevel | undefined {
  if (typeof processId !== "number" || !Number.isSafeInteger(processId)) {
    return undefined;
  }

  // A window whose owner the compositor does not know is reported as pid 0 or
  // -1. Keeping it would let it collide with every other such window.
  if (processId <= 0 || typeof title !== "string" || title === "") {
    return undefined;
  }

  return {processId: String(processId), title};
}

// NB: `pid`, `title`, `mapped`, `name`, `nodes` and `floating_nodes` below are
// the compositors' own key names. They are not this codebase's identifiers and
// must not be renamed to match its conventions.

/** `hyprctl -j clients`: one flat array, one entry per window. */
export function parseHyprlandClients(output: string): Toplevel[] {
  const toplevels: Toplevel[] = [];
  for (const client of asArray(parseJson(output))) {
    // An unmapped client is a window that is not on screen; counting it would
    // make its application look like it had two.
    if (isRecord(client) && client.mapped !== false) {
      const found = toplevel(client.pid, client.title);
      if (found !== undefined) {
        toplevels.push(found);
      }
    }
  }

  return toplevels;
}

/** `swaymsg -t get_tree`: outputs containing workspaces containing windows. */
export function parseSwayTree(output: string): Toplevel[] {
  const toplevels: Toplevel[] = [];

  const visit = (node: unknown) => {
    if (!isRecord(node)) {
      return;
    }

    // Outputs and workspaces have a `name` too — "HDMI-A-1", "3" — and it is
    // the absent `pid` that tells them apart from the windows inside them.
    const found = toplevel(node.pid, node.name);
    if (found !== undefined) {
      toplevels.push(found);
    }

    // Floating windows hang off a second list, and are as real as the tiled
    // ones; a video player is very often exactly there.
    for (const child of [
      ...asArray(node.nodes),
      ...asArray(node.floating_nodes),
    ]) {
      visit(child);
    }
  };

  visit(parseJson(output));
  return toplevels;
}

/** The window ids out of `xprop -root _NET_CLIENT_LIST`. */
export function parseXpropClientList(output: string): string[] {
  const match = /^_NET_CLIENT_LIST\(WINDOW\): window id # (?<ids>.*)$/mv.exec(
    output,
  );
  if (match === null) {
    return [];
  }

  return match
    .groups!.ids!.split(",")
    .map((id) => id.trim())
    .filter((id) => /^0x[\da-f]+$/iv.test(id));
}

// Undoing the escaping xprop puts in, which would otherwise end the string it
// is printing early.
function unescape(text: string): string {
  return text.replaceAll(
    /\\(?<escaped>["\\n])/gv,
    // A real newline would break the single-line control this ends up in, so
    // it becomes a space rather than being passed through.
    (_match, escaped: string) => (escaped === "n" ? " " : escaped),
  );
}

/** One window's `xprop -id … _NET_WM_PID _NET_WM_NAME WM_NAME`. */
export function parseXpropWindow(output: string): Toplevel | undefined {
  const pid = /^_NET_WM_PID\(CARDINAL\) = (?<pid>\d+)$/mv.exec(output);
  if (pid === null) {
    return undefined;
  }

  // _NET_WM_NAME is UTF-8 and is what a title with anything but English in it
  // survives; WM_NAME is Latin-1, and only worth reading for applications old
  // enough not to set the other.
  const name =
    /^_NET_WM_NAME\([^\)]*\) = "(?<title>.*)"$/mv.exec(output) ??
    /^WM_NAME\([^\)]*\) = "(?<title>.*)"$/mv.exec(output);
  if (name === null) {
    return undefined;
  }

  const title = unescape(name.groups!.title!).trim();
  return title === "" ? undefined : {processId: pid.groups!.pid!, title};
}

/** The parent of a process, out of its `/proc/<pid>/stat`. */
export function parseParentProcessId(stat: string): string | undefined {
  // The second field is the executable's name in brackets, and may hold spaces
  // and brackets of its own — "(Web Content)", "(bash (deleted))" — so the
  // fields are counted from the last ')' rather than by splitting the line.
  const end = stat.lastIndexOf(")");
  if (end === -1) {
    return undefined;
  }

  // What follows is the state, then the parent.
  const [, parent] = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/v);
  return parent !== undefined && /^\d+$/v.test(parent) ? parent : undefined;
}

/**
 Which process each title belongs to, keeping only the ones that are not in
 doubt.

 A process with two windows open is dropped rather than guessed at: nothing
 here says which of them is making the sound, and naming a stream after the
 wrong window of the right application is worse than naming it after the
 application, because it looks specific.

 The same window can arrive twice — an XWayland window is reported by the
 compositor and by xprop both — so identical titles from one process count
 once.
 */
export function titlesByProcess(toplevels: Toplevel[]): Map<string, string> {
  const byProcess = new Map<string, Set<string>>();
  for (const {processId, title} of toplevels) {
    const titles = byProcess.get(processId) ?? new Set<string>();
    titles.add(title);
    byProcess.set(processId, titles);
  }

  const titles = new Map<string, string>();
  for (const [processId, found] of byProcess) {
    const [only] = found;
    if (found.size === 1) {
      titles.set(processId, only!);
    }
  }

  return titles;
}
