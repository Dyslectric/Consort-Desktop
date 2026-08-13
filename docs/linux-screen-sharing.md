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

### Sending system audio anyway

PipeWire exposes every sink's **monitor** as a capture device, so system audio
can be sent as if it were a microphone. In the call's audio settings, choose the
input named `Monitor of <your output device>`.

The cost is that it replaces your microphone: the call hears your system, not
you. To send both, or to send just one application rather than everything, build
a sink that combines them and select _its_ monitor:

```bash
# A sink that exists only to be captured.
pactl load-module module-null-sink sink_name=consort-share \
    sink_properties=device.description=Consort-Share

# Copy your microphone into it.
pactl load-module module-loopback source=@DEFAULT_SOURCE@ sink=consort-share

# Then move the application you want to share into that sink, by name:
pactl list sink-inputs        # find its index
pactl move-sink-input <index> consort-share
```

Now select `Monitor of Consort-Share` as the microphone. Undo it with
`pactl unload-module` on the two module ids, or by logging out.

Note that moving an application into that sink means you stop hearing it
yourself unless you also loop it back to your real output. This is fiddly, which
is why it is documented rather than automated: it rearranges the audio graph of
the whole session, and an app that does that silently on your behalf is worse
than one that tells you how.
