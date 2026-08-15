import {BrowserWindow, type WebFrameMain} from "electron/main";
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
      require(
        path.join(
          bundlePath,
          "../../native/build/Release/consort_app_audio.node",
        ),
      ) as Addon;
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

let bridge: BrowserWindow | undefined;
let capture: InstanceType<Addon["AppAudioCapture"]> | undefined;

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

  return window.webContents.mainFrame;
}

/** Stop sending, and take the bridge down with it. */
export async function stop(): Promise<void> {
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
