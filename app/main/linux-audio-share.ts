import {app} from "electron/main";
import {type ChildProcess, execFile, spawn} from "node:child_process";
import process from "node:process";

import {EVERYTHING_PLAYING} from "../common/types.ts";

import {readWindowTitles, titleForProcess} from "./linux-window-titles.ts";
import {
  type Group,
  type SinkInput,
  groupByProcess,
  parseSinkIndex,
  parseSinkInputs,
  streamName,
} from "./pactl-parse.ts";

// Sending an app's sound with a screen share on Linux.
//
// The platform supplies none of it: org.freedesktop.portal.ScreenCast has no
// audio in it at all, and Electron's loopback capture is Windows-only. So the
// sound is captured here and put on the share's own stream, as a second track,
// which is where Windows and the web client have always put it. Being the
// share's audio rather than somebody's microphone is the whole point: nothing
// applies echo cancellation, noise suppression or gain control to it, and a
// listener can turn the application down without turning down the person
// sharing it.
//
// The obvious way to capture it is wrong. The monitor of your output device
// also carries the call, because that is where the other participants are
// playing — so they hear themselves back, and nobody notices until someone else
// speaks. Instead the chosen application is moved into a sink of its own and
// only that sink is captured, so the call is never in it:
//
//     <the app> ──▶ [consort-share] ──┬──▶ the real output, so it is still heard
//                                     └──remap──▶ the screen share's audio track
//
// "The chosen application" is as narrow as the user made it: every application
// playing, one of them, or one tab of a browser. That choice is this module's
// real work — see chooseAutomatically and chooseByKey — and none of it changes
// with how the sound is delivered.
//
// It is a remapped source rather than the sink's monitor, because GNOME Settings
// hides monitors from its input list, and getUserMedia in a page is subject to
// the same filtering.
//
// There was a second delivery once: the same sound mixed with the microphone
// into a virtual input device, for a call that could carry only one audio track.
// It is gone. Two routes meant a call using both heard the application twice,
// and it changed the user's default input to do its job — rearranging the
// session's audio graph for as long as a share lasted.

const SINK = "consort-share";

// What the share's audio track is captured from: the shared applications and
// nothing else. linux-display-audio.ts opens it in the page and adds it to the
// stream getDisplayMedia returns.
//
// The description is what identifies it there. A page is given device labels and
// a per-origin hash for an id, and is told nothing of PulseAudio's own names, so
// this string is the only thing both sides can agree on.
const APP_SOURCE = "consort-share-app";
export const APP_DESCRIPTION = "Consort share";

export type ShareableApp = {
  /** Opaque handle for one application; see `groupByProcess`. */
  key: string;
  /** The window's title where the desktop will say, its application's name otherwise. */
  name: string;
  /** Sounds of its own that can be picked out — a browser's tabs. */
  streams: Array<{key: string; name: string}>;
};

// The sink and its capture source, which outlive any one share.
type Device = {
  sinkModule: string;
  /** The shared sound out to the speakers, so it is still heard here. */
  loopbackModule: string;
  /** What the share's audio track is opened from. */
  appSourceModule: string;
  /** Our own sink's index, which is how sink inputs name the sink they are on. */
  sinkIndex: string | undefined;
};

// What is currently routed into it, and every stream of it.
type Share = {
  /**
   The processes whose sound is going in. Empty for a single stream picked out
   of an application, which is the one case that must *not* grow.
   */
  processIds: string[];
  /**
   Everything playing, rather than a named application or two: what a whole
   screen share means, since a screen is not one application's. Anything that
   starts playing later joins it, whoever starts it.
   */
  everything: boolean;
  streams: Array<{index: string; originSink: string}>;
  appName: string;
};

/**
 What to call one application in the list.

 A window title for a single stream, where the desktop will give one — but the
 application's own name once it is making more than one sound, because a title
 then names one window of something being shared whole, and reads as though
 only that window were going into the call.
 */
async function displayName(
  group: Group,
  titles: ReadonlyMap<string, string>,
): Promise<string> {
  const [only] = group.streams;
  if (group.streams.length !== 1 || only === undefined) {
    return group.name;
  }

  // What the stream calls itself first: an application naming its own sound
  // knows more about it than a compositor naming the window around it, and on
  // a desktop that gives no titles at all it is the only thing that does.
  return (
    streamName(only) ??
    (await titleForProcess(titles, only.processId)) ??
    group.name
  );
}

// Our own plumbing, which PulseAudio lists as a sink input like any other: the
// loopback carrying the shared sound to the speakers. It has no application name
// and no process, so it reaches the list looking like an application called
// "loopback-1419-13 output" — and sharing the thing that reads our own sink
// would be a loop.
function isOurPlumbing(record: SinkInput): boolean {
  const current = device;
  if (current === undefined || record.ownerModule === "") {
    return false;
  }

  return record.ownerModule === current.loopbackModule;
}

let device: Device | undefined;
let building: Promise<void> | undefined;
let share: Share | undefined;
let availability: Promise<boolean> | undefined;

// Wrapped by hand rather than with promisify, whose typing treats execFile's
// ChildProcess return as a value returned where none was expected.
async function pactl(...arguments_: string[]): Promise<string> {
  return new Promise<string>((resolve, reject: (error: Error) => void) => {
    execFile("pactl", arguments_, (error, stdout) => {
      if (error === null) {
        resolve(stdout);
      } else {
        // The exception execFile gives is already an Error; this narrowing only
        // proves it to the rule that a rejection reason must be one.
        reject(
          error instanceof Error
            ? error
            : new Error(`pactl ${arguments_.join(" ")} failed`),
        );
      }
    });
  });
}

export type AudioShareStatus =
  /** Not Linux, or no PulseAudio interface to talk to. */
  | {kind: "unavailable"}
  /**
   PulseAudio found no hardware and invented a dummy device. Common in a
   virtual machine with no emulated sound card, where the feature cannot work
   and an empty list of applications would be a misleading way to say so.
   */
  | {kind: "no-output-device"}
  | {kind: "ready"; apps: ShareableApp[]};

/** Whether this machine can do any of it: Linux, with a PulseAudio interface. */
export async function isAvailable(): Promise<boolean> {
  if (process.platform !== "linux") {
    return false;
  }

  availability ??= (async () => {
    try {
      await pactl("info");
      return true;
    } catch {
      return false;
    }
  })();
  return availability;
}

/**
 What this machine can offer, and when it can offer nothing, which of the two
 reasons applies. They need different words: one is "your machine has no
 sound", the other is "nothing is making any".
 */
export async function status(): Promise<AudioShareStatus> {
  if (!(await isAvailable())) {
    return {kind: "unavailable"};
  }

  let sink: string;
  try {
    sink = (await pactl("get-default-sink")).trim();
  } catch {
    return {kind: "unavailable"};
  }

  // `auto_null` is the sink PulseAudio creates when it has no real one.
  if (sink === "" || sink.startsWith("auto_null")) {
    return {kind: "no-output-device"};
  }

  return {kind: "ready", apps: await listApps()};
}

/**
 Applications currently playing audio, excluding this one.

 Excluding ourselves is not tidiness: sharing the call's own playback would
 send every other participant's voice back to them.

 One row per application rather than per sound it is making, and named by its
 window where the desktop will say which. See linux-window-titles.ts for which
 desktops answer.
 */
/** This app's own audio, which is where the other participants are playing. */
function isThisApp(record: SinkInput): boolean {
  return record.name === app.name || record.processId === String(process.pid);
}

function shareable(records: SinkInput[]): SinkInput[] {
  return records.filter(
    (record) => !isThisApp(record) && !isOurPlumbing(record),
  );
}

async function describe(
  groups: Group[],
  titles: ReadonlyMap<string, string>,
): Promise<ShareableApp[]> {
  return Promise.all(
    groups.map(async (group) => ({
      key: group.key,
      name: await displayName(group, titles),
      streams: group.named,
    })),
  );
}

export async function listApps(): Promise<ShareableApp[]> {
  const ours = shareable(parseSinkInputs(await pactl("list", "sink-inputs")));

  // Nothing playing is nothing to name, and no reason to go asking a desktop
  // about its windows.
  if (ours.length === 0) {
    return [];
  }

  return describe(groupByProcess(ours), await readWindowTitles());
}

/** What is being shared, as the source it was chosen from describes it. */
export type SharedSource = {
  kind: "screen" | "window";
  /** The window's title, for a window. What the portal or the picker said. */
  name: string;
};

export type AutomaticChoice =
  /** Silence. Nothing to send, and nothing worth asking about. */
  | {kind: "nothing"}
  /** One answer, arrived at without asking. Pass the key to `start`. */
  | {kind: "choice"; key: string}
  /** Several answers are possible and none of them is obviously right. */
  | {kind: "ask"; apps: ShareableApp[]};

// A stream name has to be substantial before a window title containing it means
// anything. "Home" or "New Tab" will turn up inside an unrelated title sooner or
// later, and a wrong tab is worse than no tab: it is silence where the user can
// see sound playing.
const SHORTEST_MATCHABLE_NAME = 8;

// The unread badge a browser puts in front of a title, and case, which a window
// and a stream do not always agree on.
function forComparison(value: string): string {
  return value
    .replace(/^\(\d+\)\s*/v, "")
    .trim()
    .toLowerCase();
}

/**
 The one stream whose own name the shared window's title carries.

 Firefox calls its window "<the page> — Mozilla Firefox" and names the sink
 input after that same page, so the window itself says which tab it is showing.
 That matters most exactly where everything else has run out: on GNOME and KDE
 under Wayland nothing will say which process owns a window, and this asks the
 window rather than the desktop.

 Containment rather than equality, because the window adds the browser's name to
 the end of what the stream calls itself. Only ever one match: two streams whose
 names both appear in the title is not an answer.
 */
function matchStreamTitle(
  records: SinkInput[],
  windowTitle: string,
): SinkInput | undefined {
  const title = forComparison(windowTitle);
  if (title === "") {
    return undefined;
  }

  const matching = records.filter((record) => {
    const name = streamName(record);
    return (
      name !== undefined &&
      name.length >= SHORTEST_MATCHABLE_NAME &&
      title.includes(forComparison(name))
    );
  });

  const [match] = matching;
  return matching.length === 1 ? match : undefined;
}

/**
 What to send with a share when nobody has been asked.

 Windows asks nothing at all: every share there carries the whole desktop's
 sound, because the sound of the thing you are showing people is part of
 showing it to them. This works out the same answer where it can, and only
 falls back to asking when the machine genuinely does not know which of several
 applications was meant.

 A screen is nobody's application, so a screen share takes everything —
 including whatever starts later, which is how a video opened mid-call reaches
 the other end. A window is narrower in a way that matters: the tab it is
 showing, where the title says which, and otherwise the application that owns
 it, identified by its title where the desktop will say (Hyprland, sway, and
 anything under XWayland; see linux-window-titles.ts).

 What it will not do is take a whole browser because a browser is the only thing
 playing. Every tab and every window of it go through one process, so that sends
 three other tabs and the window next to the one being shared — which is not
 what sharing a window means, and is a strange thing to do without asking.
 */
export async function chooseAutomatically(
  source: SharedSource,
): Promise<AutomaticChoice> {
  const ours = shareable(parseSinkInputs(await pactl("list", "sink-inputs")));
  if (ours.length === 0) {
    return {kind: "nothing"};
  }

  if (source.kind === "screen") {
    return {kind: "choice", key: EVERYTHING_PLAYING};
  }

  const groups = groupByProcess(ours);

  // The window's own title first, since it is the only thing that can name a
  // tab, and the only thing at all on the desktops that answer nothing else.
  const tab = matchStreamTitle(ours, source.name);
  if (tab !== undefined) {
    return {kind: "choice", key: `stream:${tab.index}`};
  }

  // Only now is a window title worth the several `xprop` calls it costs: this
  // is the one branch that cannot be answered without one.
  const titles = await readWindowTitles();
  const named = await Promise.all(
    groups.map(async (group) => {
      const [first] = group.streams;
      const title =
        first === undefined
          ? undefined
          : await titleForProcess(titles, first.processId);
      return {group, title};
    }),
  );

  const matching = named.filter((found) => found.title === source.name);
  const [match] = matching;
  if (match !== undefined && matching.length === 1) {
    return {kind: "choice", key: match.group.key};
  }

  // One application playing, with nothing inside it that can be told from
  // anything else inside it: there is only one answer, so it is not a question.
  //
  // An application with named streams is the opposite case and used to take this
  // same branch, which is how sharing one Firefox window came to send every tab
  // in every Firefox window. Where the parts are distinguishable and the title
  // did not say which was meant, the user is the only one who knows.
  const [only] = groups;
  if (only !== undefined && groups.length === 1 && only.named.length === 0) {
    return {kind: "choice", key: only.key};
  }

  return {kind: "ask", apps: await describe(groups, titles)};
}

export function activeShare(): {appName: string} | undefined {
  return share === undefined ? undefined : {appName: share.appName};
}

/**
 Create the sink and its capture source, if they are not there already.

 Called when a screen share begins rather than when an application is chosen, so
 that the device is enumerable by the time the page goes looking for it — which
 it does in the moment `getDisplayMedia` resolves, with no time to spare.
 Nothing is routed into it yet, so until a share starts it carries silence.

 One build at a time, remembered by its promise rather than by `device` — which
 is only set at the *end* of a build several `pactl` calls long. A share now
 starts one of these and routes the sound moments later, and two builds running
 over each other would load a second copy of every module with the first left
 orphaned and nothing pointing at it.
 */
export async function ensureDevice(): Promise<void> {
  building ??= buildDevice().catch((error: unknown) => {
    // A build that failed must not be remembered as one that happened.
    building = undefined;
    throw error;
  });
  await building;
}

async function buildDevice(): Promise<void> {
  if (device !== undefined || !(await isAvailable())) {
    return;
  }

  const speakers = (await pactl("get-default-sink")).trim();
  if (speakers === "" || speakers.startsWith("auto_null")) {
    return;
  }

  // One sink, holding the applications being shared and nothing else. The
  // microphone never comes near it: the share's audio track is the application
  // alone, and a voice mixed into it could not be turned down separately at the
  // far end — which is the whole reason this is a track rather than a
  // microphone.
  const sinkModule = (
    await pactl(
      "load-module",
      "module-null-sink",
      `sink_name=${SINK}`,
      `sink_properties=device.description='${APP_DESCRIPTION}'`,
    )
  ).trim();

  // Any failure past this point unwinds rather than leaving half a graph.
  const undo: string[] = [sinkModule];
  try {
    // The app, out to the speakers, so that moving it into a sink of our own
    // does not take it away from the person sharing it.
    const loopbackModule = (
      await pactl(
        "load-module",
        "module-loopback",
        `source=${SINK}.monitor`,
        `sink=${speakers}`,
        "latency_msec=40",
      )
    ).trim();
    undo.push(loopbackModule);

    const appSourceModule = (
      await pactl(
        "load-module",
        "module-remap-source",
        `source_name=${APP_SOURCE}`,
        `master=${SINK}.monitor`,
        `source_properties=device.description='${APP_DESCRIPTION}'`,
      )
    ).trim();
    undo.push(appSourceModule);

    // Our own sink's index, so that a stream PulseAudio puts here of its own
    // accord is not mistaken for one that has somewhere to go back to.
    // module-stream-restore remembers where an application's audio last went,
    // so the tab opened after a share began can arrive here already.
    let sinkIndex: string | undefined;
    try {
      sinkIndex = parseSinkIndex(await pactl("list", "short", "sinks"), SINK);
    } catch {
      sinkIndex = undefined;
    }

    device = {
      sinkModule,
      loopbackModule,
      appSourceModule,
      sinkIndex,
    };
  } catch (error: unknown) {
    // Sequential and in reverse load order on purpose: a sink cannot be
    // unloaded while something is still attached to it.
    for (const module of undo.toReversed()) {
      try {
        // eslint-disable-next-line no-await-in-loop -- order matters here
        await pactl("unload-module", module);
      } catch {
        // Best effort; the original failure is the one worth reporting.
      }
    }

    throw error;
  }
}

// Nothing tells this process that a call ended or that a screen share stopped:
// the page simply drops the track, and Electron reports nothing. But the effects
// are visible in the audio graph — the call stops recording from the device,
// or the shared application exits — so those are watched for instead.
//
// Without this the routing outlives the call that wanted it, leaving a banner on
// screen and an application playing into a sink nobody is listening to.
//
// This is the slow half of the watch. Sink inputs coming and going are followed
// by `pactl subscribe` instead, which is near-instant; the poll stays for what
// subscribe cannot see — a call that has quietly stopped recording — and as a
// backstop for a subscription that dies.
const WATCH_INTERVAL_MS = 4000;
let watch: NodeJS.Timeout | undefined;
let idleRounds = 0;
let silentRounds = 0;

// Long enough to gather the handful of events one stream starting produces,
// short enough that nobody hears the gap.
const SETTLE_MS = 120;
let events: ChildProcess | undefined;
let settle: NodeJS.Timeout | undefined;
let reconciling = false;
let pending = false;

/** Called when the routing stops on its own, so the banner can go too. */
let onEnded: (() => void) | undefined;

export function setOnEnded(callback: () => void): void {
  onEnded = callback;
}

async function isSomethingRecordingOurSource(): Promise<boolean> {
  // `pactl list short source-outputs` gives the source index rather than its
  // name, so the long form is needed to match by name.
  const output = await pactl("list", "source-outputs");
  return output.includes(APP_SOURCE);
}

// What the application starts after the share began — the next video, a tab
// opened since — belongs in the share too. Without this, sharing Firefox means
// sharing the one sound Firefox happened to be making when the button was
// pressed, and a browser destroys that stream at the end of every video.
async function adoptNewStreams(
  current: Share,
  records: SinkInput[],
): Promise<void> {
  if (!current.everything && current.processIds.length === 0) {
    return;
  }

  const known = new Set(current.streams.map((stream) => stream.index));
  // A whole screen is nobody's application, so everything that starts playing
  // on it belongs to the share — including something opened after it began,
  // which is the ordinary way a video gets watched together.
  const candidates = current.everything ? shareable(records) : records;
  const fresh = candidates.filter(
    (record) =>
      (current.everything || current.processIds.includes(record.processId)) &&
      !known.has(record.index) &&
      // Already here, which means PulseAudio put it here rather than us. It has
      // no earlier sink to be returned to.
      record.sink !== device?.sinkIndex,
  );

  await Promise.all(
    fresh.map(async (record) => {
      try {
        await pactl("move-sink-input", record.index, SINK);
        current.streams.push({index: record.index, originSink: record.sink});
      } catch {
        // It stopped playing in the moment between being listed and being
        // moved, which the next round will see for itself.
      }
    }),
  );
}

/**
 Streams the session parked on our sink by itself, put back where they belong.

 Moving a stream is how PulseAudio's `module-stream-restore` — and WirePlumber's
 `restore-stream`, on PipeWire — is *taught* where an application's sound goes.
 So sharing a browser once teaches the session that every stream that browser
 makes from now on belongs on our sink, and they arrive here on their own with
 no move of ours behind them. Then picking one tab sends every tab: ours was
 moved, and the rest were already sitting here waiting to be captured.

 That memory lives in the session rather than in this app, so it outlives
 reinstalling, and there is no per-stream way to ask not to be remembered. What
 there is, is this: anything here that this share did not put here goes back to
 the default sink.

 Nothing is evicted from a share of everything, where every application is
 wanted — except this app's own audio, which is never wanted anywhere near it.
 */
async function evictStrangers(
  current: Share,
  records: SinkInput[],
): Promise<void> {
  const sinkIndex = device?.sinkIndex;
  if (sinkIndex === undefined) {
    return;
  }

  const ours = new Set(current.streams.map((stream) => stream.index));
  const strangers = records.filter((record) => {
    if (record.sink !== sinkIndex || isOurPlumbing(record)) {
      return false;
    }

    if (isThisApp(record)) {
      return true;
    }

    return (
      !current.everything &&
      !ours.has(record.index) &&
      !current.processIds.includes(record.processId)
    );
  });

  if (strangers.length === 0) {
    return;
  }

  let home: string;
  try {
    home = (await pactl("get-default-sink")).trim();
  } catch {
    return;
  }

  // Sending them to our own sink would be no eviction at all, and there is
  // nowhere else to guess at.
  if (home === "" || home === SINK) {
    return;
  }

  await Promise.all(
    strangers.map(async (record) => {
      try {
        await pactl("move-sink-input", record.index, home);
      } catch {
        // It stopped playing between being listed and being moved.
      }
    }),
  );
}

async function stillWanted(): Promise<boolean> {
  const current = share;
  if (current === undefined) {
    return false;
  }

  const records = parseSinkInputs(await pactl("list", "sink-inputs"));

  // The backstop, for a subscription that never started or has died. Skipped
  // while one is running, because these records were read before it began and
  // acting on them would undo what it has just done — adopting back a stream it
  // evicted a moment ago, and round again.
  if (!reconciling) {
    await adoptNewStreams(current, records);
    // After adopting, so that what was just taken on purpose is not shown the
    // door in the same round.
    await evictStrangers(current, records);
  }

  // What has ended is no longer ours to put back.
  const playing = new Set(records.map((record) => record.index));
  current.streams = current.streams.filter((stream) =>
    playing.has(stream.index),
  );

  // The shared application closed — or paused. Silence is not the same as
  // gone: a browser tears down its stream between one video and the next, and
  // ending the share there would end it every time somebody paused.
  //
  // Not for a whole screen, which has no application to close. There the share
  // is silent until somebody plays something, and ending it after twelve
  // seconds of quiet would mean the video started a minute in arrives nowhere.
  if (!current.everything && current.streams.length === 0) {
    silentRounds += 1;
    if (silentRounds >= 3) {
      return false;
    }
  } else {
    silentRounds = 0;
  }

  // Nobody is listening. Given a round of grace, because a call switching
  // devices releases the old one for a moment before opening the new.
  if (await isSomethingRecordingOurSource()) {
    idleRounds = 0;
    return true;
  }

  idleRounds += 1;
  return idleRounds < 3;
}

/**
 Bring the sink into line with what the share is supposed to hold.

 Both halves at once, because they are two sides of one question: what has
 started playing and belongs here, and what has arrived here without being
 asked. Answering it on a four-second timer meant a tab opened mid-share could
 be four seconds late, and a tab the session parked here could be four seconds
 of somebody else's audio going out of the call.
 */
async function reconcile(): Promise<void> {
  if (reconciling) {
    // A round already under way has read the graph before this event happened,
    // so its answer is stale by definition. Rather than queue a second read
    // against the same one, mark it and let the round in flight go again.
    pending = true;
    return;
  }

  reconciling = true;
  try {
    do {
      pending = false;
      const current = share;
      if (current === undefined) {
        return;
      }

      // eslint-disable-next-line no-await-in-loop -- each pass reads the graph as the last one left it
      const records = parseSinkInputs(await pactl("list", "sink-inputs"));
      // eslint-disable-next-line no-await-in-loop -- as above
      await adoptNewStreams(current, records);
      // eslint-disable-next-line no-await-in-loop -- as above
      await evictStrangers(current, records);
    } while (pending);
  } catch {
    // The poll comes round every few seconds regardless.
  } finally {
    reconciling = false;
  }
}

/**
 Follow the audio graph as it changes, rather than asking every few seconds.

 `pactl subscribe` prints a line per event and never exits, which is the only
 way to hear about a sink input the moment it appears. The alternative is the
 poll below, and four seconds is a long time to be sending a call the sound of
 something nobody chose.

 Events are coalesced: one stream starting produces several of them — new, then
 a change or two as its properties arrive — and reading the whole graph once per
 line would be several `pactl list` calls for one thing happening.
 */
function startListening(): void {
  stopListening();

  let child: ChildProcess;
  try {
    child = spawn("pactl", ["subscribe"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // No subscription, so the poll is the whole watch. It still works.
    return;
  }

  events = child;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    // "Event 'new' on sink-input #123". Sinks and sources are of no interest
    // here: it is only what is playing that can arrive in the wrong place.
    if (!chunk.includes("sink-input")) {
      return;
    }

    if (settle !== undefined) {
      clearTimeout(settle);
    }

    settle = setTimeout(() => {
      settle = undefined;
      void reconcile();
    }, SETTLE_MS);
  });

  // Both are the same answer: there is no subscription any more. Neither is
  // worth reporting — `pactl` missing has already been established by then, and
  // the poll carries on either way.
  child.on("error", () => {
    if (events === child) {
      events = undefined;
    }
  });
  child.on("exit", () => {
    if (events === child) {
      events = undefined;
    }
  });
}

function stopListening(): void {
  if (settle !== undefined) {
    clearTimeout(settle);
    settle = undefined;
  }

  const child = events;
  events = undefined;
  child?.kill();
}

function startWatching(): void {
  stopWatching();
  idleRounds = 0;
  silentRounds = 0;
  startListening();
  watch = setInterval(() => {
    void (async () => {
      let wanted: boolean;
      try {
        wanted = await stillWanted();
      } catch {
        // A failed poll is not evidence of anything; try again next time.
        return;
      }

      if (!wanted) {
        await stop();
        onEnded?.();
      }
    })();
  }, WATCH_INTERVAL_MS);
}

function stopWatching(): void {
  stopListening();
  if (watch !== undefined) {
    clearInterval(watch);
    watch = undefined;
  }
}

// What a key off the list stands for: every application, one of them, or one
// sound of one.
type Chosen = {
  appName: string;
  /** Empty for one sound of an application, which is what stops it growing. */
  processIds: string[];
  everything: boolean;
  streams: SinkInput[];
};

async function chooseByKey(
  records: SinkInput[],
  key: string,
): Promise<Chosen | undefined> {
  if (key === EVERYTHING_PLAYING) {
    const all = shareable(records);
    return all.length === 0
      ? undefined
      : {
          // Named for what it is rather than for the applications in it: the
          // list changes as things start and stop, and a banner naming three
          // of them would be wrong within the minute.
          appName: "everything that is playing",
          processIds: [
            ...new Set(
              all
                .map((record) => record.processId)
                .filter((processId) => processId !== ""),
            ),
          ],
          everything: true,
          streams: all,
        };
  }

  const stream = key.startsWith("stream:")
    ? records.find((record) => record.index === key.slice("stream:".length))
    : undefined;

  if (stream !== undefined) {
    // No process id, deliberately. One tab was picked, so the others that
    // browser starts are none of the call's business — which is the whole
    // difference between this and picking the application above it.
    return {
      appName: streamName(stream) ?? stream.name,
      processIds: [],
      everything: false,
      streams: [stream],
    };
  }

  const group = groupByProcess(records).find((found) => found.key === key);
  if (group === undefined) {
    return undefined;
  }

  const [first] = group.streams;
  return {
    // The banner names what was picked out of the list, title and all. Naming
    // the application would answer a different question from the one the user
    // was just asked.
    appName: await displayName(group, await readWindowTitles()),
    processIds:
      first === undefined || first.processId === "" ? [] : [first.processId],
    everything: false,
    streams: group.streams,
  };
}

/** Route what the key names into the sink the share's audio track reads. */
export async function start(key: string): Promise<{
  appName: string;
  everything: boolean;
}> {
  if (share !== undefined) {
    await stop();
  }

  const records = parseSinkInputs(await pactl("list", "sink-inputs"));
  const chosen = await chooseByKey(records, key);
  if (chosen === undefined) {
    throw new Error("that app stopped playing audio");
  }

  if (chosen.streams.some((stream) => stream.name === app.name)) {
    throw new Error(
      "that is this app's own audio; sharing it would send everyone else's voices back to them",
    );
  }

  await ensureDevice();
  if (device === undefined) {
    throw new Error("could not create the audio device");
  }

  // All of it, not one sound of it. A stream that ends between being listed and
  // being moved is dropped rather than failing the share: a browser closing one
  // of four is not a reason to send none of them.
  const moved = await Promise.all(
    chosen.streams.map(async (stream) => {
      try {
        await pactl("move-sink-input", stream.index, SINK);
        return {index: stream.index, originSink: stream.sink};
      } catch {
        return undefined;
      }
    }),
  );

  const streams = moved.filter((stream) => stream !== undefined);
  if (streams.length === 0) {
    throw new Error("that app stopped playing audio");
  }

  // The default input is deliberately left alone. Pointing it at the share was
  // how the old microphone route reached a call that was already running, and it
  // rearranged the session's audio for as long as a share lasted — for a device
  // nothing opens any more. The share's own track needs none of it.
  share = {
    processIds: chosen.processIds,
    everything: chosen.everything,
    streams,
    appName: chosen.appName,
  };
  startWatching();

  // Now, rather than up to a watch interval later. Whatever the session had
  // already parked on our sink is in the capture from its very first moment
  // otherwise — and its first moment is the one where a call is handed the
  // track, which is the moment that decides what the share sounds like.
  try {
    await evictStrangers(
      share,
      parseSinkInputs(await pactl("list", "sink-inputs")),
    );
  } catch {
    // A share that is otherwise ready is not worth failing over this.
  }

  return {appName: chosen.appName, everything: chosen.everything};
}

/**
 Stop routing an app's sound, leaving the sink and its source in place.

 They stay because building them again costs several `pactl` calls, and the next
 share needs the device enumerable the instant its stream resolves. They go when
 the app quits.
 */
export async function stop(): Promise<void> {
  stopWatching();
  const current = share;
  if (current === undefined) {
    return;
  }

  share = undefined;

  const attempt = async (what: () => Promise<unknown>) => {
    try {
      await what();
    } catch {
      // Teardown continues regardless: one failure must not strand the rest.
    }
  };

  // The app goes home before anything else changes, or it is left pointing at
  // a sink that may not be there. Each stream to the sink it came from, which
  // is not always the same one: an application can be playing to two devices.
  await Promise.all(
    current.streams.map(async (stream) =>
      attempt(async () =>
        pactl("move-sink-input", stream.index, stream.originSink),
      ),
    ),
  );
}

/** Remove the sink and its source as well. For quitting. */
export async function teardown(): Promise<void> {
  await stop();

  // Forgotten together with the device it built, or the next share would find
  // a finished build promise and a graph that is no longer there.
  building = undefined;

  const current = device;
  if (current === undefined) {
    return;
  }

  device = undefined;

  // The remapped source, then the loopback, then the sink they both hang off;
  // unloading the sink first would strand whatever reads from it.
  for (const module of [
    current.appSourceModule,
    current.loopbackModule,
    current.sinkModule,
  ]) {
    try {
      // eslint-disable-next-line no-await-in-loop -- order matters here
      await pactl("unload-module", module);
    } catch {
      // Best effort.
    }
  }
}

// Quitting with the graph rearranged would leave the machine's audio wrong with
// nothing left running to explain why.
app.on("will-quit", (event) => {
  if (device === undefined && share === undefined) {
    return;
  }

  event.preventDefault();
  void teardown().finally(() => {
    app.quit();
  });
});
