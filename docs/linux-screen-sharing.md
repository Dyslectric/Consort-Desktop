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

## The shared window has no sound

A screen share from Linux is silent, and nothing this app can do changes that.

`getDisplayMedia` returns audio only where the platform provides it. Electron's
loopback capture is Windows-only. The Wayland route cannot help either: the
`org.freedesktop.portal.ScreenCast` interface has **no audio at all** — its
source types are monitors, windows and virtual displays, its options are
`types`, `multiple` and `cursor_mode`, and the streams it returns carry position,
size and a PipeWire node with no audio fields anywhere.

So there is no supported path by which the sound of a shared window reaches the
call, and the picker says so rather than letting you discover it from the silence
at the other end.

### Sending an application's sound anyway

The app does this for you; there is nothing to run by hand.

On **X11**, the picker has an "Also share sound from" list alongside the windows
— pick the application there and share as usual.

On **Wayland** the desktop's dialog chose the video and the app's picker never
appeared, so the offer arrives as a banner once the share is running: pick the
application and press **Share sound**.

Either way a banner then shows what is being sent, with **Stop sharing sound**.
The call gets the application's sound and your microphone together; you keep
hearing the application yourself.

#### One row per application, and its tabs underneath

The list offers **applications**, not sounds. A browser with three tabs playing
is one process making three sink inputs, all called "Firefox", and offering them
separately means three identical rows with no way to tell which is the video you
meant. Picking the application takes everything it is playing — including
whatever it starts afterwards, so the next video, or a tab opened mid-call,
joins the share on its own within a few seconds.

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

So the app moves _one application_ into a sink of its own and captures that. The
call is never in it:

```text
   <the app> ──▶ [consort-share] ──monitor──▶ the call
                       └──loopback──▶ your speakers
```

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
