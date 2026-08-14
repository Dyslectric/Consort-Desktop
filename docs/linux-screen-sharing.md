# Screen sharing on Linux

Two things differ from Windows and macOS, and both come from the platform rather
than from this app.

## Wayland does the choosing

On Wayland, `desktopCapturer.getSources()` opens the desktop's own portal dialog
— GNOME's or KDE's "Share your screen" — and returns only the source the user
picked there. There is no way to enumerate windows behind its back; that is the
point of the portal.

So on Wayland this app does **not** draw its own picker. Doing so would ask the
same question twice, and the second dialog could not offer a different answer:
the portal has already handed back exactly one source. Dismissing the portal
dialog is a refusal, and the share fails as it should.

On X11 there is no portal, so the app's own picker appears and _is_ the consent.
The detection is `XDG_SESSION_TYPE=wayland` or a set `WAYLAND_DISPLAY`.

If you are on Wayland and no dialog appears at all, the portal is missing rather
than the app being broken. Install the backend for your desktop —
`xdg-desktop-portal-gnome`, `xdg-desktop-portal-kde` or
`xdg-desktop-portal-wlr` — alongside `xdg-desktop-portal` and PipeWire.

## The platform sends no sound with a shared window

`getDisplayMedia` returns audio only where the platform provides it. Electron's
loopback capture is Windows-only. The Wayland route cannot help either: the
`org.freedesktop.portal.ScreenCast` interface has **no audio at all** — its
source types are monitors, windows and virtual displays, its options are
`types`, `multiple` and `cursor_mode`, and the streams it returns carry position,
size and a PipeWire node with no audio fields anywhere.

So the sound of the window you shared never arrives with the video, and nothing
this app does changes that. What it does instead is put the sound of what is
playing **onto the share**, as a second track of the same stream.

### It happens by itself

On Windows every share carries the whole desktop's sound and nothing asks you
first, because the sound of the thing you are showing people is part of showing
it to them. Linux behaves the same way here, by working out the answer rather
than by asking for it:

| What you share                     | What goes with it                                   |
| ---------------------------------- | --------------------------------------------------- |
| An entire screen                   | Everything playing, including whatever starts later |
| A window, and one thing is playing | That application                                    |
| A window your desktop can name     | The application that owns the window                |
| Anything, with nothing playing     | Nothing, and no question about it                   |

A banner then says what is being sent, with **Stop sharing sound**. That banner
is the whole of the disclosure — nothing else tells you — so it stays up for as
long as the sound is going out. You keep hearing the application yourself.

Consort's own audio is never included, which is not tidiness: it is where the
other participants are playing, and sending it back is sending them themselves.

#### When it does ask

One case is left: a **window** share, with several applications playing, on a
desktop that will not say which window belongs to which of them — GNOME and KDE
under Wayland, for the reasons further down. Guessing there would put the wrong
sound into a call, so instead:

- on **X11**, the picker's "Also share sound from" list is already on screen and
  already starts on the answer the app would have chosen. Change it before you
  pick a window, or set it to "Nothing".
- on **Wayland**, the desktop's dialog has been and gone, so a banner asks —
  and the share waits behind it for a few seconds. The video starts either way:
  after about eight seconds it goes without sound rather than leaving you
  looking at a share that never began. Answering afterwards still sends the
  sound, as a microphone rather than as part of the share.

#### Turning it off

**Settings → General → Functionality → "Send an application's sound when you
share your screen"**. Off means off: nothing is routed, no banner asks, and the
picker loses its sound list. The audio graph is left alone entirely.

#### What reaches the other end

The application's sound alone, with no microphone in it, captured with echo
cancellation, noise suppression and automatic gain control explicitly **off**.
Those are microphone defaults, and applied to music or a game they are what
makes a share sound underwater.

There is still a second, older route: the same sound is mixed with your voice
into a virtual microphone. Both exist while the change is being made, so a call
that takes the sound from the screen share **and** uses "Consort share" as its
microphone hears it twice. Until the mixed device goes, pick a real microphone
in that call.

The wrapper that adds the track lives in `app/main/linux-display-audio.ts`. It
is injected into every frame from the main process rather than installed in the
webview preload, which is the obvious place and does not work: the preload runs
in an isolated world the page cannot see into, and only in the main frame, while
a call is a cross-origin iframe. `tools/preload-world-probe` measures all of
that, and is what to re-run if a future Electron behaves differently.

#### One row per application, and its tabs underneath

The list offers **applications**, not sounds, with "Everything that is playing"
above them where there is more than one. A browser with three tabs playing is
one process making three sink inputs, all called "Firefox", and offering them
separately means three identical rows with no way to tell which is the video you
meant. Picking the application takes everything it is playing — including
whatever it starts afterwards, so the next video, or a tab opened mid-call,
joins the share on its own within a few seconds. So does "everything": a whole
screen is nobody's application, and what appears on it later belongs to the
share as much as what was there when it started.

Where an application names its own sounds, those appear beneath it as well:

```text
Firefox ▸ All of its sound
        ▸ Never Gonna Give You Up - YouTube
        ▸ Lo-fi beats to relax to - YouTube
Moonlight
```

Picking one of those shares that sound alone, and deliberately does _not_ pick up
what the application starts later — that asymmetry is the whole difference
between the two kinds of row.

This works because Firefox names each stream after the page. It is the only
per-tab identity there is: both browsers put every tab's audio through a single
process, so nothing else in the audio graph separates them. An application that
names its streams `Playback`, `AudioStream` or `Audio Stream` is saying nothing,
and gets no tab rows rather than rows called "Audio Stream". Neither do two tabs
carrying the same title, since picking one of those would be a guess.

#### What the list calls things

A row for a single sound is named after the **window** making it where your
desktop will say which — "Never Gonna Give You Up — Mozilla Firefox" rather than
"Firefox".

PulseAudio knows nothing about windows, so the title comes from the compositor,
matched to the stream by process id. Whether that works is up to the compositor:

| Desktop                 | Titles                | How                                                                 |
| ----------------------- | --------------------- | ------------------------------------------------------------------- |
| Hyprland                | Yes                   | `hyprctl -j clients`                                                |
| sway                    | Yes                   | `swaymsg -t get_tree`                                               |
| X11, any window manager | Yes                   | `xprop`, from `x11-utils`                                           |
| GNOME, KDE Plasma       | XWayland windows only | `xprop` reaches those; the session's own Wayland windows, see below |

That last row is the one to know when testing: on GNOME or KDE an application
running under XWayland is named after its window like anywhere else, and a
native Wayland one beside it keeps its application name. Nothing is wrong when
that happens.

GNOME's `org.gnome.Shell.Introspect.GetWindows` is allowlisted to the GTK
portal and refuses anything else — and carries no process id anyway, so it
would not be enough even if it answered. KWin can read every window's caption
and pid, but a script has no way to return a value: it runs inside KWin and
gets data out only by calling a D-Bus service, which this app would have to own
a name on to receive.

So on those two the list keeps the application names, which is what it showed
everywhere before. Nothing here is required to work — a desktop that will not
say, or a missing `xprop`, costs a title and nothing else.

An application with two windows open is named after the application, not after
one of them. Nothing in the audio graph says which window is making the sound,
and the wrong title is worse than the application name because it looks
specific. A stream's own name is preferred to a window title where it has one,
since an application naming its own sound knows more about it than a compositor
naming the window around it.

Consort's own plumbing never appears. The loopbacks carrying the shared sound to
your speakers and to the call are sink inputs like any other, with no application
name and no process behind them, so they would otherwise reach the list as an
application called `loopback-1419-13 output` — and sharing the one reading our
own sink would be a loop. They are excluded by the module that made them, which
is exact, rather than by matching their names, which would not be.

#### Why not simply capture your speakers

The advice everywhere else is "select `Monitor of <your output>` as your
microphone". It appears to work and it is wrong: your output is also where the
**call** is playing, so you capture the other participants and send them back to
themselves. Nobody notices while only you are talking, which is the worst way for
a bug to behave.

So the app moves the applications it is sending into a sink of its own and
captures that. The call is never in it, however many of them there are:

```text
   <the apps> ──▶ [consort-share] ──monitor──▶ the call
                        └──loopback──▶ your speakers
```

This is also why "everything that is playing" is not the same as capturing your
speakers, though the two sound alike as a description: everything means every
application _except this one_, moved one by one, and the difference is whether
the call is in it.

Consort's own audio is never offered in the list, for the same reason.

Your microphone is mixed into that sink as well, which is what makes it safe for
the app to leave it as the default input while sharing: anything else recording
hears your voice _as well as_ the shared application, rather than instead of it.

Everything is `pactl load-module`, `move-sink-input`, `set-default-source` and
`unload-module` — see `app/main/linux-audio-share.ts`. Stopping restores the
previous default input and returns the application to the sink it came from
before unloading anything, so it is never left pointing at a sink that has gone.
Quitting the app tears it down too, rather than leaving the session's audio
rearranged with nothing running to explain why.
