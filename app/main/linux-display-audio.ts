import {
  type Session,
  type WebFrameMain,
  app,
  webContents,
  webFrameMain,
} from "electron/main";
import process from "node:process";

import {APP_DESCRIPTION} from "./linux-audio-share.ts";

// Putting the shared application's sound on the screen share itself.
//
// On Windows, getDisplayMedia hands back a stream with an audio track already
// in it, and lib-jitsi-meet takes that track as it stands: no echo
// cancellation, no noise suppression, no gain control, because it is not a
// microphone and nobody is talking into it. Linux has nothing of the kind —
// the ScreenCast portal carries no audio at all — so linux-audio-share.ts
// smuggles the application into the call through a *microphone* instead, and
// every microphone default is then applied to music.
//
// This puts it where Windows puts it. The stream is amended in the page: the
// real getDisplayMedia is awaited, and a track captured from
// `consort-share-app` — the application alone, with no microphone mixed in —
// is added to it before the caller ever sees it.
//
// It cannot be done from the main process, which is where the rest of screen
// sharing is decided. setDisplayMediaRequestHandler answers with a *source
// descriptor* and Chromium builds the MediaStream in the renderer; nothing in
// that reply can name a PulseAudio device, and `audio: "loopback"` is
// Windows-only.
//
// Nor from the preload, which is the obvious place and quietly does nothing:
//
//   - contextIsolation is on, so the preload's `navigator` is not the page's.
//     Assigning getDisplayMedia there patches an object no page code will ever
//     look at, and the failure mode is silence — the wrapper is never wrong,
//     it simply never runs.
//   - A preload runs in the main frame only. A call is a cross-origin iframe,
//     so even with isolation off, the frame calling getDisplayMedia is not the
//     frame the preload is in.
//
// Both were measured rather than assumed; tools/preload-world-probe checks
// them, and is the thing to re-run if a future Electron changes its mind.
//
// So the wrapper is injected from here, into every frame, in the page's own
// world — and told from here whether an application is routed, because a page
// has no IPC of its own to ask with.
//
// It goes in on navigation rather than when a share starts, which looks late by
// comparison and is the only workable order: by the time anything in this app
// hears about a share, getDisplayMedia has already been called, and wrapping a
// function the page has already invoked changes nothing about the promise it is
// waiting on.

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- merging into a DOM interface, which only an interface can do
  interface MediaDevices {
    /**
     Whether an application's sound is routed into `consort-share-app` at this
     moment, kept up to date from the main process.

     It hangs off the page's own `navigator.mediaDevices` because that is the
     one object both sides can reach: the wrapper below closes over it, and
     `setRouted` writes to it by name.
     */
    consortSharedAppAudio?: {routed: boolean};
  }
}

/**
 The wrapper, as it runs inside the page.

 Serialised with `toString()` and evaluated there, so nothing in this module is
 in scope and everything it needs arrives as an argument — the same trick as
 `WebView.create`. Called again on every change of routing, when it does
 nothing but carry the new answer in.
 */
function attachSharedAudio(
  this: undefined,
  description: string,
  routed: boolean,
): void {
  // An insecure origin has no navigator.mediaDevices whatsoever. It has no
  // screen sharing either, so there is nothing here worth wrapping.
  const media: MediaDevices | undefined = navigator.mediaDevices;
  if (media === undefined) {
    return;
  }

  const installed = media.consortSharedAppAudio;
  if (installed !== undefined) {
    installed.routed = routed;
    return;
  }

  const state = {routed};
  media.consortSharedAppAudio = state;

  const capture = media.getDisplayMedia.bind(media);
  media.getDisplayMedia = async (options) => {
    const stream = await capture(options);

    // Nothing routed means `consort-share-app` exists but is carrying silence,
    // which is worse than no track at all: the call would show the share as
    // having sound, and offer a volume control over nothing.
    //
    // An audio track already there is a platform that grew the ability while
    // nobody was looking, and is not to be doubled.
    if (!state.routed || stream.getAudioTracks().length > 0) {
      return stream;
    }

    try {
      // Devices are enumerated here, at the end of the share, rather than kept
      // from earlier: labels are empty until the page holds a media
      // permission, and by now the capture has been granted and a call has
      // long since asked for the microphone. Matched by description because
      // that is the only thing of PulseAudio's naming that reaches a page —
      // deviceId is a per-origin hash, and the source's real name is not
      // exposed at all.
      const devices = await media.enumerateDevices();
      const device = devices.find(
        (found) =>
          found.kind === "audioinput" && found.label.includes(description),
      );
      if (device === undefined) {
        return stream;
      }

      const audio = await media.getUserMedia({
        audio: {
          deviceId: {exact: device.deviceId},
          // Every one of these is a microphone default, and every one of them
          // is wrong here. RTCUtils is not on this path, so nothing else turns
          // them off: gain control rides the volume of anything with quiet
          // passages, noise suppression takes a synthesiser for hiss, and echo
          // cancellation ducks the application whenever anyone speaks — which
          // together are exactly the underwater sound this exists to avoid.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          // Asked for rather than insisted on, so a source that turns out to be
          // mono still arrives instead of failing the capture over it.
          channelCount: 2,
        },
      });
      // Added and then left alone. When the routing stops the track goes
      // silent by itself, and ending it instead is a signal a call may read as
      // the share itself ending — "stop sharing sound" must not take the video
      // with it. Whoever stops the video stops this too, being the call that
      // took it.
      for (const track of audio.getAudioTracks()) {
        stream.addTrack(track);
      }
    } catch {
      // The share is worth more than its sound. Anything here — a refused
      // microphone permission, a device that went away between being listed
      // and being opened — leaves the video exactly as it was, and the
      // microphone route still carries the application as it did before.
    }

    return stream;
  };
}

let watched: Session | undefined;
let routed = false;

function script(): string {
  return `(${attachSharedAudio.toString()})(${JSON.stringify(
    APP_DESCRIPTION,
  )}, ${JSON.stringify(routed)})`;
}

async function run(frame: WebFrameMain): Promise<void> {
  try {
    await frame.executeJavaScript(script());
  } catch (error: unknown) {
    // A frame that navigated or died while this was in flight, most often.
    // Nothing here is worth failing a screen share over.
    console.error("could not reach a frame with the shared audio wrapper", {
      url: frame.url,
      error,
    });
  }
}

/**
 Wrap getDisplayMedia in every frame of the servers' session.

 Every frame, rather than the one a call is in, because nothing here can tell
 which that is until it asks for a screen — and by then it is too late to wrap
 anything. The wrapper is inert in all the others: it adds a track only while
 an application is routed, which only a screen share can bring about.
 */
export function install(ses: Session): void {
  // Windows already sends the shared window's audio with the video, and macOS
  // has neither this problem nor the PulseAudio graph that answers it.
  if (process.platform !== "linux") {
    return;
  }

  watched = ses;
  app.on("web-contents-created", (_event, contents) => {
    contents.on(
      "did-frame-navigate",
      (
        _navigation,
        _url,
        _code,
        _status,
        _isMainFrame,
        processId,
        routingId,
        // eslint-disable-next-line max-params
      ) => {
        if (contents.session !== ses) {
          return;
        }

        const frame = webFrameMain.fromId(processId, routingId);
        if (frame !== undefined) {
          void run(frame);
        }
      },
    );
  });
}

/**
 Say whether an application's sound is routed, and wait until the pages know.

 Awaited by the caller on purpose. The page's getDisplayMedia is blocked on a
 source that the same reply releases, so telling the pages afterwards is a race
 against the video — one this side would sometimes lose, and lose silently.

 Wayland is the one case this cannot help: there the portal grants the video
 before the app has asked which application's sound to send, so the flag is
 still false when the stream resolves. The microphone route remains the only
 one there, which is among the reasons it is still there.
 */
export async function setRouted(nowRouted: boolean): Promise<void> {
  if (process.platform !== "linux" || nowRouted === routed) {
    return;
  }

  routed = nowRouted;

  const ses = watched;
  if (ses === undefined) {
    return;
  }

  const frames = webContents.getAllWebContents().flatMap((contents) => {
    if (contents.isDestroyed() || contents.session !== ses) {
      return [];
    }

    // Including the main frame, which is what `framesInSubtree` means.
    return contents.mainFrame.framesInSubtree;
  });

  await Promise.all(frames.map(async (frame) => run(frame)));
}
