import {app} from "electron/main";
import {execFile} from "node:child_process";
import process from "node:process";

import {parseSinkInputs} from "./pactl-parse.ts";

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
  /** PulseAudio sink-input index. Stable only for the life of the stream. */
  index: string;
  name: string;
};

// The virtual microphone, which outlives any one share.
type Device = {
  sinkModule: string;
  mixModule: string;
  loopbackModule: string;
  mixAppModule: string;
  sourceModule: string;
  micModule: string | undefined;
};

// One app currently routed into it.
type Share = {
  streamIndex: string;
  originSink: string;
  previousDefaultSource: string | undefined;
  appName: string;
};

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
 */
export async function listApps(): Promise<ShareableApp[]> {
  const records = parseSinkInputs(await pactl("list", "sink-inputs"));
  return records
    .filter(
      (record) =>
        record.name !== app.name && record.processId !== String(process.pid),
    )
    .map(({index, name}) => ({index, name}));
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

    device = {
      sinkModule,
      mixModule,
      loopbackModule,
      mixAppModule,
      sourceModule,
      micModule,
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

/** Route one app's sound into the microphone the call can already see. */
export async function start(streamIndex: string): Promise<{
  deviceDescription: string;
  appName: string;
}> {
  if (share !== undefined) {
    await stop();
  }

  const records = parseSinkInputs(await pactl("list", "sink-inputs"));
  const chosen = records.find((record) => record.index === streamIndex);
  if (chosen === undefined) {
    throw new Error("that app stopped playing audio");
  }

  if (chosen.name === app.name) {
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

  await pactl("move-sink-input", streamIndex, SINK);

  // Anything that opens a microphone *after* this gets the right one without
  // being told. A call already running still has to be pointed at it by hand,
  // which is why the banner names the device.
  await pactl("set-default-source", SOURCE);

  share = {
    streamIndex,
    originSink: chosen.sink,
    previousDefaultSource,
    appName: chosen.name,
  };

  return {deviceDescription: DESCRIPTION, appName: chosen.name};
}

/**
 Stop routing an app's sound, leaving the microphone in place.

 The device stays because removing it would make the next share wait for a call
 to notice a new one all over again — the very thing creating it early avoids.
 It goes when the app quits.
 */
export async function stop(): Promise<void> {
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
  // a sink that may not be there.
  await attempt(async () =>
    pactl("move-sink-input", current.streamIndex, current.originSink),
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
