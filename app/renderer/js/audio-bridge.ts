import {ipcRenderer} from "./typed-ipc-renderer.ts";

// Playing the captured application's sound, so that Chromium can capture it
// back out of this frame as the screen share's audio track.
//
// WHY a frame at all: the display media reply carries either `loopback`, which
// is the whole machine, or a frame of ours. The sound wanted is neither — it is
// one application's, captured natively — so it is played here and this frame is
// handed over. See app/main/windows-app-audio.ts.
//
// In the preload rather than the page, following main.ts: a preload has both
// ipcRenderer and the Web Audio API, and the page needs no script of its own —
// which is why its content security policy can forbid every source there is.
//
// The scheduling is the only subtle part. Chunks arrive as they are captured,
// in the order they were played, and each is scheduled to start where the last
// one ended. Playing each on arrival instead would leave the gaps between IPC
// messages audible as clicks.

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;

// How far ahead of the clock to start, the first time and after a gap. Long
// enough to absorb the jitter of chunks arriving over IPC, short enough that
// nobody notices the sound lagging the picture.
//
// A fifth of a second rather than the twentieth it began with, because that was
// audibly not enough: a chunk arriving after its slot has passed is a gap, and
// gaps are clicks. This buys room for the jitter and none for the drift — the
// capture clock and the audio clock are both nominally 48 kHz and are not the
// same clock, so the queue still creeps. The fix for that is a ring buffer read
// by an AudioWorklet, which resamples the difference away instead of
// rescheduling around it.
const LEAD_SECONDS = 0.2;

// When the scheduled end has fallen this far behind the clock, the queue has
// dried up — the application went quiet, or the machine stalled — and the next
// chunk starts afresh rather than trying to catch up on a backlog that is no
// longer worth playing.
const RESET_SECONDS = 0.3;

let context: AudioContext | undefined;
let nextStart = 0;

/**
 The audio graph, started as soon as the page is, and kept running.

 Not created on the first buffer, which is what this did and which leaves the
 frame with no audio at all in the moment the share is handed over — and a frame
 that is not making a sound yet is a frame Chromium may decline to capture. A
 silent source holds it open until there is something real to play.
 */
function ensureContext(): AudioContext {
  if (context !== undefined) {
    return context;
  }

  context = new AudioContext({sampleRate: SAMPLE_RATE});
  const silence = context.createConstantSource();
  silence.offset.value = 0;
  silence.connect(context.destination);
  silence.start();
  // Suspended is the autoplay policy's doing, and a page with no user gesture
  // behind it never gets one — so it is asked for directly rather than waited
  // for.
  void context.resume();
  return context;
}

function play(chunk: Uint8Array): void {
  context = ensureContext();

  const samples = chunk.length / 2 / CHANNELS;
  if (samples === 0) {
    return;
  }

  // A DataView, because what arrives is not what was sent: a Buffer crossing
  // IPC is rebuilt as a plain Uint8Array, and every Buffer method with it —
  // readInt16LE included — is gone by the time it lands here.
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const buffer = context.createBuffer(CHANNELS, samples, SAMPLE_RATE);
  for (let channel = 0; channel < CHANNELS; channel += 1) {
    const target = buffer.getChannelData(channel);
    for (let frame = 0; frame < samples; frame += 1) {
      // Interleaved 16-bit signed, which is what the capture asks Windows for.
      // 32768 rather than 32767: the negative extreme is the one that clips.
      target[frame] =
        view.getInt16((frame * CHANNELS + channel) * 2, true) / 32_768;
    }
  }

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);

  const now = context.currentTime;
  if (nextStart < now + RESET_SECONDS - LEAD_SECONDS) {
    nextStart = now + LEAD_SECONDS;
  }

  source.start(nextStart);
  nextStart += buffer.duration;
}

ensureContext();

ipcRenderer.on("app-audio-chunk", (event, chunk: Uint8Array) => {
  try {
    play(chunk);
  } catch (error: unknown) {
    // One bad buffer is not worth ending a share over, and the next one is
    // along in a few milliseconds.
    console.error("could not play a captured buffer", error);
  }
});
