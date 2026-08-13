import {app} from "electron/main";
import {execFile} from "node:child_process";
import process from "node:process";

import {readWindowTitles, titleForProcess} from "./linux-window-titles.ts";
import {
  type Group,
  type SinkInput,
  groupByProcess,
  parseSinkIndex,
  parseSinkInputs,
  streamName,
} from "./pactl-parse.ts";

// Sending an app's sound into a call on Linux.
//
// A screen share carries no audio here: org.freedesktop.portal.ScreenCast has
// no audio in it at all, and Electron's loopback capture is Windows-only. What
// PipeWire can do is give the call a *microphone* that happens to be carrying
// the app's output.
//
// The obvious way to do that is wrong. Capturing the monitor of your output
// device also captures the call, because that is where the other participants
// are playing — so they hear themselves back, and nobody notices until someone
// else speaks. Instead one app is moved into a sink of its own and only that
// sink is captured, so the call is never in it:
//
//     <the app> ──▶ [consort-share] ──┬──▶ the real output, so it is still heard
//                                     └──▶ [consort-share-mix] ──remap──▶ the call
//                   <the microphone> ──────▶ [consort-share-mix]
//
// Two sinks rather than one, because the microphone must reach the call and not
// the speakers. Mixing it into the sink that feeds the speakers would play a
// person's own voice back at them, and without headphones that is a howl.
//
// The device is deliberately built in two stages. A call enumerates its input
// devices when it starts and will not notice one that appears later, so the
// microphone is created as soon as a screen share begins — before anyone has
// chosen what to share — and an app's audio is only routed into it afterwards.
// Creating it at the moment of choosing, which is the obvious thing to do, is
// too late: the device is real but the call never sees it.
//
// It is a remapped source rather than the sink's monitor, because GNOME Settings
// hides monitors from its input list and an app that filters them the same way
// leaves the user with a device they cannot pick.

const SINK = "consort-share";
const MIX = "consort-share-mix";
const SOURCE = "consort-share-mic";
const DESCRIPTION = "Consort share";

export type ShareableApp = {
  /** Opaque handle for one application; see `groupByProcess`. */
  key: string;
  /** The window's title where the desktop will say, its application's name otherwise. */
  name: string;
  /** Sounds of its own that can be picked out — a browser's tabs. */
  streams: Array<{key: string; name: string}>;
};

// The virtual microphone, which outlives any one share.
type Device = {
  sinkModule: string;
  mixModule: string;
  loopbackModule: string;
  mixAppModule: string;
  sourceModule: string;
  micModule: string | undefined;
  /** Our own sink's index, which is how sink inputs name the sink they are on. */
  sinkIndex: string | undefined;
};

// One app currently routed into it, and every stream of it.
type Share = {
  /** Undefined for a stream PulseAudio named no process for. */
  processId: string | undefined;
  streams: Array<{index: string; originSink: string}>;
  previousDefaultSource: string | undefined;
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

// Our own plumbing, which PulseAudio lists as sink inputs like any other: the
// loopbacks carrying the shared sound to the speakers and to the call. They
// have no application name and no process, so they reach the list looking like
// an application called "loopback-1419-13 output" — and sharing the one that
// reads our own sink would be a loop.
function isOurPlumbing(record: SinkInput): boolean {
  const current = device;
  if (current === undefined || record.ownerModule === "") {
    return false;
  }

  return [
    current.loopbackModule,
    current.mixAppModule,
    current.micModule,
  ].includes(record.ownerModule);
}

let device: Device | undefined;
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
export async function listApps(): Promise<ShareableApp[]> {
  const records = parseSinkInputs(await pactl("list", "sink-inputs"));
  const ours = records.filter(
    (record) =>
      record.name !== app.name &&
      record.processId !== String(process.pid) &&
      !isOurPlumbing(record),
  );

  // Nothing playing is nothing to name, and no reason to go asking a desktop
  // about its windows.
  if (ours.length === 0) {
    return [];
  }

  const titles = await readWindowTitles();
  return Promise.all(
    groupByProcess(ours).map(async (group) => ({
      key: group.key,
      name: await displayName(group, titles),
      streams: group.named,
    })),
  );
}

export function activeShare(): {appName: string} | undefined {
  return share === undefined ? undefined : {appName: share.appName};
}

/**
 Create the microphone, if it is not there already.

 Called when a screen share begins rather than when an app is chosen, because a
 call enumerates its inputs once and will not pick up a device that appears
 afterwards. Nothing is routed into it yet, so until a share starts it is a
 silent microphone that happens to exist.
 */
export async function ensureDevice(): Promise<void> {
  if (device !== undefined || !(await isAvailable())) {
    return;
  }

  const speakers = (await pactl("get-default-sink")).trim();
  if (speakers === "" || speakers.startsWith("auto_null")) {
    return;
  }

  // Two sinks, not one. The shared app has to reach both the speakers (so the
  // person sharing still hears it) and the call; the microphone must reach the
  // call *only*. Mixing the microphone into the sink that feeds the speakers
  // would play the user's own voice back at them, and on speakers rather than
  // headphones that is a feedback loop.
  const sinkModule = (
    await pactl(
      "load-module",
      "module-null-sink",
      `sink_name=${SINK}`,
      `sink_properties=device.description='${DESCRIPTION}'`,
    )
  ).trim();

  // Any failure past this point unwinds rather than leaving half a graph.
  const undo: string[] = [sinkModule];
  try {
    const mixModule = (
      await pactl(
        "load-module",
        "module-null-sink",
        `sink_name=${MIX}`,
        `sink_properties=device.description='${DESCRIPTION} mix'`,
      )
    ).trim();
    undo.push(mixModule);

    // The app, out to the speakers.
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

    // The app, into the mix the call hears.
    const mixAppModule = (
      await pactl(
        "load-module",
        "module-loopback",
        `source=${SINK}.monitor`,
        `sink=${MIX}`,
        "latency_msec=40",
      )
    ).trim();
    undo.push(mixAppModule);

    // The microphone, into the mix and nowhere else — unless the "microphone"
    // is a monitor of an output, which is what a machine with no capture
    // hardware reports. Looping that in would feed the speakers back round.
    let defaultSource: string;
    try {
      defaultSource = (await pactl("get-default-source")).trim();
    } catch {
      defaultSource = "";
    }

    let micModule: string | undefined;
    if (defaultSource !== "" && !defaultSource.endsWith(".monitor")) {
      micModule = (
        await pactl(
          "load-module",
          "module-loopback",
          `source=${defaultSource}`,
          `sink=${MIX}`,
          "latency_msec=40",
        )
      ).trim();
      undo.push(micModule);
    }

    const sourceModule = (
      await pactl(
        "load-module",
        "module-remap-source",
        `source_name=${SOURCE}`,
        `master=${MIX}.monitor`,
        `source_properties=device.description='${DESCRIPTION}'`,
      )
    ).trim();
    undo.push(sourceModule);

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
      mixModule,
      loopbackModule,
      mixAppModule,
      sourceModule,
      micModule,
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
// Without this the routing outlives the call that wanted it, leaving a banner
// on screen and the user's default input pointing at a microphone carrying an
// application nobody is listening to.
const WATCH_INTERVAL_MS = 4000;
let watch: NodeJS.Timeout | undefined;
let idleRounds = 0;
let silentRounds = 0;

/** Called when the routing stops on its own, so the banner can go too. */
let onEnded: (() => void) | undefined;

export function setOnEnded(callback: () => void): void {
  onEnded = callback;
}

async function isSomethingRecordingOurSource(): Promise<boolean> {
  // `pactl list short source-outputs` gives the source index rather than its
  // name, so the long form is needed to match by name.
  const output = await pactl("list", "source-outputs");
  return output.includes(SOURCE);
}

// What the application starts after the share began — the next video, a tab
// opened since — belongs in the share too. Without this, sharing Firefox means
// sharing the one sound Firefox happened to be making when the button was
// pressed, and a browser destroys that stream at the end of every video.
async function adoptNewStreams(
  current: Share,
  records: SinkInput[],
): Promise<void> {
  if (current.processId === undefined) {
    return;
  }

  const known = new Set(current.streams.map((stream) => stream.index));
  const fresh = records.filter(
    (record) =>
      record.processId === current.processId &&
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

async function stillWanted(): Promise<boolean> {
  const current = share;
  if (current === undefined) {
    return false;
  }

  const records = parseSinkInputs(await pactl("list", "sink-inputs"));
  await adoptNewStreams(current, records);

  // What has ended is no longer ours to put back.
  const playing = new Set(records.map((record) => record.index));
  current.streams = current.streams.filter((stream) =>
    playing.has(stream.index),
  );

  // The shared application closed — or paused. Silence is not the same as
  // gone: a browser tears down its stream between one video and the next, and
  // ending the share there would end it every time somebody paused.
  if (current.streams.length === 0) {
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

function startWatching(): void {
  stopWatching();
  idleRounds = 0;
  silentRounds = 0;
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
  if (watch !== undefined) {
    clearInterval(watch);
    watch = undefined;
  }
}

// What a key off the list stands for: a whole application, or one sound of one.
type Chosen = {
  appName: string;
  /** Set only for a whole application, which is what makes it grow. */
  processId: string | undefined;
  streams: SinkInput[];
};

async function chooseByKey(
  records: SinkInput[],
  key: string,
): Promise<Chosen | undefined> {
  const stream = key.startsWith("stream:")
    ? records.find((record) => record.index === key.slice("stream:".length))
    : undefined;

  if (stream !== undefined) {
    // No process id, deliberately. One tab was picked, so the others that
    // browser starts are none of the call's business — which is the whole
    // difference between this and picking the application above it.
    return {
      appName: streamName(stream) ?? stream.name,
      processId: undefined,
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
    processId:
      first === undefined || first.processId === ""
        ? undefined
        : first.processId,
    streams: group.streams,
  };
}

/** Route one app's sound into the microphone the call can already see. */
export async function start(key: string): Promise<{
  deviceDescription: string;
  appName: string;
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

  let previousDefaultSource: string | undefined;
  try {
    previousDefaultSource = (await pactl("get-default-source")).trim();
  } catch {
    previousDefaultSource = undefined;
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

  // Anything that opens a microphone *after* this gets the right one without
  // being told. A call already running still has to be pointed at it by hand,
  // which is why the banner names the device.
  await pactl("set-default-source", SOURCE);

  share = {
    processId: chosen.processId,
    streams,
    previousDefaultSource,
    appName: chosen.appName,
  };
  startWatching();

  return {deviceDescription: DESCRIPTION, appName: chosen.appName};
}

/**
 Stop routing an app's sound, leaving the microphone in place.

 The device stays because removing it would make the next share wait for a call
 to notice a new one all over again — the very thing creating it early avoids.
 It goes when the app quits.
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

  if (current.previousDefaultSource !== undefined) {
    await attempt(async () =>
      pactl("set-default-source", current.previousDefaultSource!),
    );
  }

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

/** Remove the microphone as well. For quitting. */
export async function teardown(): Promise<void> {
  await stop();

  const current = device;
  if (current === undefined) {
    return;
  }

  device = undefined;

  // The remapped source, then the loopbacks, then the sinks they all hang off;
  // unloading a sink first would strand whatever reads from it.
  for (const module of [
    current.sourceModule,
    current.micModule,
    current.mixAppModule,
    current.loopbackModule,
    current.mixModule,
    current.sinkModule,
  ]) {
    if (module !== undefined) {
      try {
        // eslint-disable-next-line no-await-in-loop -- order matters here
        await pactl("unload-module", module);
      } catch {
        // Best effort.
      }
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
