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
// else speaks. Instead one app is moved into a sink of its own and only
// that sink is captured, so the call is never in it:
//
//     <the app> ──▶ [consort-share] ──monitor──▶ the call
//                         └──loopback──▶ the real output, so it is still heard
//
// The microphone is mixed in too, which is what makes it safe to leave as the
// default input while sharing: anything recording gets the user's voice plus
// the shared app, rather than a silent-to-them substitution.

const SINK = "consort-share";
const DESCRIPTION = "Consort share";

export type ShareableApp = {
  /** PulseAudio sink-input index. Stable only for the life of the stream. */
  index: string;
  name: string;
};

type Active = {
  sinkModule: string;
  loopbackModule: string;
  micModule: string | undefined;
  streamIndex: string;
  originSink: string;
  previousDefaultSource: string | undefined;
  appName: string;
};

let active: Active | undefined;
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
  return active === undefined ? undefined : {appName: active.appName};
}

/**
 Route one app's sound to a sink of its own and make that sink's
 monitor the default input, so the call picks it up.
 */
export async function start(streamIndex: string): Promise<{
  deviceDescription: string;
  appName: string;
}> {
  if (active !== undefined) {
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

  // Where it should still be heard, so the machine does not go silent for the
  // person sharing.
  const speakers = (await pactl("get-default-sink")).trim();
  let previousDefaultSource: string | undefined;
  try {
    previousDefaultSource = (await pactl("get-default-source")).trim();
  } catch {
    previousDefaultSource = undefined;
  }

  const sinkModule = (
    await pactl(
      "load-module",
      "module-null-sink",
      `sink_name=${SINK}`,
      `sink_properties=device.description='${DESCRIPTION}'`,
    )
  ).trim();

  // From here on, any failure has to undo what came before it rather than leave
  // the audio graph half rearranged.
  const undo: string[] = [sinkModule];
  try {
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

    const micModule = (
      await pactl(
        "load-module",
        "module-loopback",
        "source=@DEFAULT_SOURCE@",
        `sink=${SINK}`,
        "latency_msec=40",
      )
    ).trim();
    undo.push(micModule);

    await pactl("move-sink-input", streamIndex, SINK);

    // Making it the default input is what saves the user a trip into the call's
    // audio settings. It is safe to do because the microphone is mixed in:
    // anything else recording hears their voice as well, not instead.
    await pactl("set-default-source", `${SINK}.monitor`);

    active = {
      sinkModule,
      loopbackModule,
      micModule,
      streamIndex,
      originSink: chosen.sink,
      previousDefaultSource,
      appName: chosen.name,
    };
  } catch (error: unknown) {
    // Sequential and in reverse load order on purpose: a sink cannot be
    // unloaded while a loopback is still attached to it.
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

  return {deviceDescription: DESCRIPTION, appName: chosen.name};
}

/** Put the audio graph back. Safe to call when nothing is active. */
export async function stop(): Promise<void> {
  const current = active;
  if (current === undefined) {
    return;
  }

  active = undefined;

  const attempt = async (what: () => Promise<unknown>) => {
    try {
      await what();
    } catch {
      // Teardown continues regardless: a module that cannot be unloaded must
      // not strand the ones that can.
    }
  };

  if (current.previousDefaultSource !== undefined) {
    await attempt(async () =>
      pactl("set-default-source", current.previousDefaultSource!),
    );
  }

  // The app goes home before its sink disappears, or it is left
  // pointing at something that no longer exists.
  await attempt(async () =>
    pactl("move-sink-input", current.streamIndex, current.originSink),
  );

  // Loopbacks first, then the sink they were attached to.
  for (const module of [
    current.micModule,
    current.loopbackModule,
    current.sinkModule,
  ]) {
    if (module !== undefined) {
      // eslint-disable-next-line no-await-in-loop -- order matters here
      await attempt(async () => pactl("unload-module", module));
    }
  }
}

// Quitting with the graph rearranged would leave the machine's audio wrong with
// nothing left running to explain why.
app.on("will-quit", (event) => {
  if (active === undefined) {
    return;
  }

  event.preventDefault();
  void stop().finally(() => {
    app.quit();
  });
});
