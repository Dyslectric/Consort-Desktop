// The two blips push to talk makes, when it is asked to make them.
//
// Synthesised rather than played from a file, because they are two sine waves
// with an envelope on them and a pair of assets would be a pair of assets to
// ship, decode and keep. It also puts the pitch, the length and the loudness in
// one place where they can be argued about, which a .ogg does not.
//
// WHY a sound at all: the gate is invisible and lives in front of a mute button
// that is not it. Without a confirmation, the way you learn that the key did
// not register is that nobody heard the sentence — and the way you learn it is
// stuck open is not at all.
//
// It is played for the person holding the key, out of their own speakers. It is
// not mixed into the call, and it does not go through the gate. A microphone in
// the same room can hear it, which is what echo cancellation is for; the tones
// are short and soft partly for that reason.

// A fifth apart, the higher one for opening. Which is which matters more than
// what they are: rising is the near-universal grammar for "on", and a pair a
// fifth apart is distinguishable through a laptop speaker at low volume.
const OPEN_HZ = 880;
const CLOSE_HZ = 587;

// Short enough to be out of the way before the first syllable, long enough to
// have a pitch at all — much under this and both ends are a click.
const LENGTH_SECONDS = 0.06;

// The fade in and out. A sine that starts and stops at full amplitude clicks,
// and a click is the one thing this must not add to the top of a sentence.
const FADE_SECONDS = 0.008;

// Quiet. This is a confirmation, not an alert, and it plays dozens of times an
// hour for somebody who talks a lot.
const LEVEL = 0.08;

let context: AudioContext | undefined;

/** Sound the gate opening or shutting. */
export function playPushToTalkTone(open: boolean): void {
  try {
    // Made on the first tone rather than at startup: somebody who never turns
    // this on should not have an audio context open for the life of the app.
    context ??= new AudioContext();
    // The autoplay policy suspends a context created without a gesture behind
    // it. There has been one — the settings were switched on by hand — but the
    // context may also have been suspended since, and asking is cheap.
    void context.resume();

    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = open ? OPEN_HZ : CLOSE_HZ;

    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(LEVEL, now + FADE_SECONDS);
    envelope.gain.setValueAtTime(LEVEL, now + LENGTH_SECONDS - FADE_SECONDS);
    envelope.gain.linearRampToValueAtTime(0, now + LENGTH_SECONDS);

    oscillator.connect(envelope);
    envelope.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + LENGTH_SECONDS);
  } catch (error: unknown) {
    // A machine with no output device, or a context the browser declined to
    // start. The gate itself is unaffected and is the part that matters.
    console.error("could not play the push-to-talk tone", error);
  }
}
