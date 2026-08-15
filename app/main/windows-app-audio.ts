import {BrowserWindow, type WebFrameMain, app} from "electron/main";
import type {Buffer} from "node:buffer";
import path from "node:path";
import process from "node:process";

import {bundlePath, bundleUrl} from "../common/paths.ts";

import {send} from "./typed-ipc-main.ts";

// Sending one application's sound with a screen share, on Windows.
//
// The capture itself is native — Electron reaches no API that can do it; see
// native/src/app-audio-win.cc. What is here is the other half of the problem,
// which is getting the result into a call.
//
// A screen share's audio has to arrive as part of the stream getDisplayMedia
// returns, and the only audio that reply can carry is `loopback` — the whole
// machine — or a frame of our own. So this plays the captured sound into a
// window nobody sees and hands Chromium that window: the frame is ours, the
// sound in it is the shared application's, and what comes out is an ordinary
// audio track on the ordinary path. No injection into the call's page, no
// socket, no relaxing of anybody's content security policy.
//
// Chromium mutes local playback of a frame it is capturing, which is what makes
// the bridge inaudible here — the shared application is already coming out of
// the speakers, and a second copy would be both an echo and a lie about what is
// being sent.
//
// The window is created when a share needs it and destroyed when the share
// ends. It holds an AudioContext and a running capture thread; leaving one
// behind means a process quietly playing silence for as long as the app runs.

type Addon = {
  isSupported: () => boolean;
  listAudioSessions: () => Array<{processId: number; active: boolean}>;
  describeWindow: (
    windowHandle: number,
  ) => {processId: number; name?: string} | null;
  AppAudioCapture: new () => {
    start: (
      processId: number,
      includeProcessTree: boolean,
      onChunk: (chunk: Buffer) => void,
      onError: (message: string) => void,
    ) => void;
    stop: () => void;
  };
};

let addon: Addon | undefined;
let addonUnavailable = false;

/**
 Where the compiled addon is, which is not the same place twice.

 In a packaged app it is an extra resource rather than part of the bundle: a
 native module cannot be loaded from inside an asar archive at all, so it has to
 sit beside one. In a working tree it is wherever node-gyp left it.
 */
function addonPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", "consort_app_audio.node")
    : path.join(
        bundlePath,
        "../../native/build/Release/consort_app_audio.node",
      );
}

/**
 The native half, loaded the first time it is wanted.

 A missing or unloadable binary is a feature that is not there rather than an
 app that will not start: every caller here treats undefined as "cannot send an
 application's sound", and the picker stops offering it.
 */
function load(): Addon | undefined {
  if (addon !== undefined || addonUnavailable) {
    return addon;
  }

  try {
    addon =
      // A compiled addon carries no type information and cannot be imported as
      // a module, so this is the one place its shape is taken on trust. Every
      // call through it is wrapped, and a binary that does not answer as
      // expected fails as a feature that is missing rather than as a crash.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, unicorn/prefer-module, @typescript-eslint/no-unsafe-type-assertion -- a native addon has neither an ESM form nor types
      require(addonPath()) as Addon;
  } catch (error: unknown) {
    console.error("could not load the application audio addon", error);
    addonUnavailable = true;
  }

  return addon;
}

/** Whether this machine can send one application's sound at all. */
export function isAvailable(): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  return load()?.isSupported() ?? false;
}

/**
 The process ids currently rendering audio, as Windows sees them.

 The same question the Linux side asks PulseAudio, and asked for the same
 reason: an application that is not making a sound is not worth offering, and
 knowing which are lets the picker answer without asking.
 */
export function playingProcessIds(): Set<number> {
  const loaded = load();
  if (loaded === undefined) {
    return new Set();
  }

  try {
    return new Set(
      loaded.listAudioSessions().map((session) => session.processId),
    );
  } catch (error: unknown) {
    console.error("could not list what is playing", error);
    return new Set();
  }
}

/**
 The application a shared window belongs to, where its sound could be sent.

 Undefined when there is nothing to offer: not Windows, no addon, a source that
 is a whole screen rather than a window, or a window whose process will not say
 what it is. The picker treats all of those the same way — it offers everything
 or nothing, which is what it could do before any of this existed.

 Whether the application is making a sound right now is deliberately not asked.
 Linux lists what is playing because it can only route a stream that exists;
 this attaches to a process, which is free to start playing a minute later, and
 an option that vanished because a video was paused would be worse than one that
 is occasionally pointless.
 */
export function appForSource(
  sourceId: string,
): {processId: number; name: string} | undefined {
  const loaded = load();
  if (loaded === undefined) {
    return undefined;
  }

  // `window:<HWND>:<n>`, which is Electron's own format and the only place the
  // handle is exposed. A screen source says `screen:` and has no process behind
  // it at all.
  const handle = /^window:(?<handle>\d+):/v.exec(sourceId)?.groups?.handle;
  if (handle === undefined) {
    return undefined;
  }

  try {
    const described = loaded.describeWindow(Number(handle));
    if (described?.name === undefined) {
      return undefined;
    }

    return {processId: described.processId, name: described.name};
  } catch (error: unknown) {
    console.error(
      "could not work out which application owns that window",
      error,
    );
    return undefined;
  }
}

let bridge: BrowserWindow | undefined;
let capture: InstanceType<Addon["AppAudioCapture"]> | undefined;
let watch: NodeJS.Timeout | undefined;

// How often to ask whether the call still wants this, and how long to wait for
// it to want it in the first place. Nothing tells this process that a share
// ended — the page drops the track and Electron reports nothing — but the
// effect is visible on the bridge: Chromium stops capturing the frame, and
// isBeingCaptured says so. It is the same question the Linux side asks about
// its source, in the only dialect Windows offers.
const WATCH_INTERVAL_MS = 2000;

// Capture does not begin the instant the reply is given: the page has to build
// the stream and attach the track first. Stopping during that gap would end
// every share a moment after starting it, so the watch waits before it starts
// believing a negative answer.
const WATCH_GRACE_ROUNDS = 5;

/**
 Stop when the share does, without being told.

 Left running, a capture outlives the call that wanted it — nothing receives the
 sound any more, but the application is still being recorded, which is not a
 thing to leave switched on because the event to switch it off never arrived.
 */
function watchForTheEnd(window: BrowserWindow): void {
  let rounds = 0;
  let everCaptured = false;

  watch = setInterval(() => {
    if (window.isDestroyed()) {
      void stop();
      return;
    }

    rounds += 1;
    if (window.webContents.isBeingCaptured()) {
      everCaptured = true;
      return;
    }

    // Never captured at all, for long enough that it was not going to be: the
    // share was refused, or ended before it began. Captured and then not:
    // the call has let go. Both mean the same thing here.
    if (everCaptured || rounds > WATCH_GRACE_ROUNDS) {
      void stop();
    }
  }, WATCH_INTERVAL_MS);
}

/**
 Start sending the sound of one process, and answer with the frame carrying it.

 The frame is what the display media reply needs, so this returns it rather than
 keeping it: the caller is the only thing that knows whether the share it
 belongs to was granted.

 Undefined means the sound could not be arranged, and a share should go ahead
 without it — the picture is worth more than its audio, which is the same rule
 the Linux path follows.
 */
export async function start(
  processId: number,
): Promise<WebFrameMain | undefined> {
  const loaded = load();
  if (loaded === undefined) {
    return undefined;
  }

  await stop();

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      // The page is ours and loads from disk; the preload is where the sound is
      // played, which is why it needs Node and the page does not.
      preload: path.join(bundlePath, "../preload/audio-bridge.cjs"),
      sandbox: false,
      // Chromium will not run an AudioContext in a page it considers hidden
      // unless it is told the window matters. Without this the bridge plays
      // nothing and the share is silent for no visible reason.
      backgroundThrottling: false,
    },
  });

  try {
    await window.loadURL(
      new URL("app/renderer/audio-bridge.html", bundleUrl).href,
    );
  } catch (error: unknown) {
    console.error("could not open the audio bridge", error);
    window.destroy();
    return undefined;
  }

  bridge = window;

  const capturing = new loaded.AppAudioCapture();
  capture = capturing;

  capturing.start(
    processId,
    // The tree, not the process alone: a browser renders its audio in a child
    // of the process owning the window, and so do a good number of applications
    // that look like one program from the outside.
    true,
    (chunk) => {
      if (!window.isDestroyed()) {
        send(window.webContents, "app-audio-chunk", chunk);
      }
    },
    (message) => {
      // Reported rather than thrown: by now the share has been granted, and
      // there is nothing left to refuse. The sound is simply absent, and this
      // is the only place that says why.
      console.error("application audio capture failed:", message);
    },
  );

  watchForTheEnd(window);
  return window.webContents.mainFrame;
}

/** Stop sending, and take the bridge down with it. */
export async function stop(): Promise<void> {
  if (watch !== undefined) {
    clearInterval(watch);
    watch = undefined;
  }

  const capturing = capture;
  capture = undefined;
  if (capturing !== undefined) {
    capturing.stop();
  }

  const window = bridge;
  bridge = undefined;
  if (window !== undefined && !window.isDestroyed()) {
    window.destroy();
  }
}
