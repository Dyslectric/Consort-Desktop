// What does screen capture actually look like on this Linux session?
//
// The Wayland branch in app/main/index.ts rests on a claim from Electron's
// documentation: under PipeWire, getSources() opens the desktop's own portal
// dialog and returns only the source the user picked. That is why the app skips
// drawing a picker of its own there. This probe checks the claim on a real
// desktop, which a Windows development machine cannot do.
//
// Run it on the Linux box under test:
//
//     npx electron@42 tools/linux-capture-probe
//
// It needs no Consort deployment and no call. Expect the desktop's own
// "Share your screen" dialog to appear; pick something.

const {app, BrowserWindow, desktopCapturer, session} = require("electron");
const path = require("node:path");
const process = require("node:process");

const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);

// The same test the app makes, kept deliberately identical.
const portalChooses =
  process.platform === "linux" &&
  (process.env.XDG_SESSION_TYPE === "wayland" ||
    Boolean(process.env.WAYLAND_DISPLAY));

app.whenReady().then(async () => {
  console.log("\n=== session ===");
  line("platform", process.platform);
  line("XDG_SESSION_TYPE", process.env.XDG_SESSION_TYPE ?? "<unset>");
  line("WAYLAND_DISPLAY", process.env.WAYLAND_DISPLAY ?? "<unset>");
  line("DISPLAY", process.env.DISPLAY ?? "<unset>");
  line("XDG_CURRENT_DESKTOP", process.env.XDG_CURRENT_DESKTOP ?? "<unset>");
  line("app would", portalChooses ? "TRUST THE PORTAL" : "DRAW ITS OWN PICKER");

  console.log("\n=== desktopCapturer.getSources ===");
  console.log("  (the desktop's own dialog should appear now)");
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: {width: 0, height: 0},
    });
  } catch (error) {
    console.log(`  THREW: ${error}`);
    console.log(
      "\n  A failure here usually means no portal backend is installed.\n" +
        "  Install xdg-desktop-portal plus the one for your desktop\n" +
        "  (xdg-desktop-portal-gnome / -kde / -wlr), and pipewire.\n",
    );
    app.exit(1);
    return;
  }

  line("sources returned", String(sources.length));
  for (const source of sources) {
    console.log(`    - ${source.id}  ${JSON.stringify(source.name)}`);
  }

  console.log("\n=== verdict ===");
  if (portalChooses && sources.length === 1) {
    console.log("  As assumed: the portal chose, and returned exactly one");
    console.log("  source. Skipping the app's own picker is correct.");
  } else if (portalChooses && sources.length === 0) {
    console.log("  The portal returned nothing — dismissed, or no backend.");
    console.log("  The app treats this as a refusal, which is right.");
  } else if (portalChooses) {
    console.log(`  UNEXPECTED: the portal returned ${sources.length} sources.`);
    console.log("  The app currently takes the first. If these are genuinely");
    console.log("  different choices, it should fall through to its own");
    console.log("  picker instead. Report this back.");
  } else {
    console.log("  X11 (or no Wayland): the app draws its own picker, and the");
    console.log(`  ${sources.length} sources above are what it will list.`);
  }

  // Now the real path, end to end: a page calling getDisplayMedia through the
  // same handler shape the app installs.
  console.log("\n=== getDisplayMedia through a handler ===");
  const ses = session.defaultSession;
  let handlerFired = false;
  ses.setDisplayMediaRequestHandler((request, callback) => {
    handlerFired = true;
    void (async () => {
      const found = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: {width: 0, height: 0},
      });
      const [chosen] = found;
      console.log(
        `  handler fired; ${found.length} source(s); ` +
          `${chosen === undefined ? "granting nothing" : `granting ${JSON.stringify(chosen.name)}`}`,
      );
      callback(chosen === undefined ? {} : {video: chosen});
    })();
  });

  // A real file, not a data: URL — those are not secure contexts, so
  // navigator.mediaDevices is undefined in them and the call cannot be made
  // at all.
  const win = new BrowserWindow({show: false});
  await win.loadFile(path.join(__dirname, "index.html"));
  let outcome;
  try {
    outcome = await win.webContents.executeJavaScript(
      `(navigator.mediaDevices === undefined
          ? Promise.resolve("navigator.mediaDevices is undefined (not a secure context)")
          : navigator.mediaDevices.getDisplayMedia({video: true})
              .then((stream) => "stream with " + stream.getVideoTracks().length +
                    " video and " + stream.getAudioTracks().length + " audio track(s)")
              .catch((error) => error.name + ": " + error.message))`,
      true,
    );
  } catch (error) {
    outcome = `probe itself failed: ${error}`;
  }
  line("handler was called", String(handlerFired));
  line("page received", outcome);
  console.log(
    "\n  This probe never asks for audio, so zero audio tracks says nothing on\n" +
      "  its own. What matters on Linux is that asking would not have helped:\n" +
      "  the ScreenCast portal carries no audio at all, and Electron's loopback\n" +
      "  capture is Windows-only. See docs/linux-screen-sharing.md.\n",
  );

  app.exit(0);
});
