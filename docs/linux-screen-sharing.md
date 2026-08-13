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
