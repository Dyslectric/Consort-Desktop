// Where can a getDisplayMedia wrapper actually be installed?
//
// app/main/linux-display-audio.ts adds the shared application's sound to the
// stream getDisplayMedia returns, which means running code in the page. The
// obvious place for that is the webview preload, and it does not work. This
// probe is why, and is the thing to re-run if a future Electron changes any of
// it:
//
//   1. contextIsolation is on by default, so the preload's `navigator` is not
//      the page's. A patch applied there is invisible to page code — and fails
//      by never running rather than by throwing, which is how it can look for a
//      long time like it works.
//   2. A preload runs in the main frame only. A call is a cross-origin iframe,
//      so it would be the wrong frame even without isolation.
//   3. The main process can execute in any frame's own world, at any depth,
//      which is what the app does instead.
//
// Nothing here is Linux-specific — the walls are Electron's, not PulseAudio's —
// so it answers the same on any platform:
//
//     npx electron@42 tools/preload-world-probe
//
// It uses Chromium's fake capture devices, so it needs no microphone, no
// desktop session worth the name, and no Consort deployment.

const {
  BrowserWindow,
  app,
  desktopCapturer,
  session,
  webContents,
  webFrameMain,
} = require("electron");
const http = require("node:http");
const path = require("node:path");
const url = require("node:url");

const OUTER_PORT = 38111;
const INNER_PORT = 38112; // A second port is a second origin: a real iframe.

const line = (label, value) => {
  console.log(`  ${String(label).padEnd(38)} ${value}`);
};

// The `allow` list is not decoration: a cross-origin iframe gets no microphone
// without it, and the wrapper's getUserMedia is a microphone as far as
// permissions policy is concerned. A Jitsi call's iframe carries exactly this,
// which is why the app can rely on it.
const OUTER = `<!doctype html><meta charset="utf-8"><title>outer</title>
<body>outer<iframe src="http://127.0.0.1:${INNER_PORT}/"
  allow="microphone; display-capture"></iframe></body>`;

// Page-authored code, in the page's own world, standing in for the call: what
// it can see of the wrapper is the only thing that matters.
const INNER = `<!doctype html><meta charset="utf-8"><title>inner</title>
<body>inner<script>
  window.probeWrapperName = () => navigator.mediaDevices.getDisplayMedia.name;
  window.probeShare = async () => {
    // A microphone first, deliberately. enumerateDevices reports empty labels
    // until the page holds a media permission, exactly as it would before a
    // call has asked for one.
    const microphone = await navigator.mediaDevices.getUserMedia({audio: true});
    for (const track of microphone.getTracks()) track.stop();

    const stream = await navigator.mediaDevices.getDisplayMedia({video: true});
    const [audio] = stream.getAudioTracks();
    return JSON.stringify({
      video: stream.getVideoTracks().length,
      audio: stream.getAudioTracks().length,
      settings: audio === undefined ? null : {
        echoCancellation: audio.getSettings().echoCancellation,
        noiseSuppression: audio.getSettings().noiseSuppression,
        autoGainControl: audio.getSettings().autoGainControl,
        channelCount: audio.getSettings().channelCount,
      },
    });
  };
</script></body>`;

// The wrapper the app injects, cut down to what is being tested. The real one
// is app/main/linux-display-audio.ts; this copy carries the same two-stage
// shape — installed once, told afterwards whether anything is routed — because
// that ordering is half of what is being checked.
function attachSharedAudio(description, routed) {
  const media = navigator.mediaDevices;
  const installed = media.consortSharedAppAudio;
  if (installed !== undefined) {
    installed.routed = routed;
    return;
  }

  const state = {routed};
  media.consortSharedAppAudio = state;

  const capture = media.getDisplayMedia.bind(media);
  media.getDisplayMedia = async function consortWrapped(options) {
    const stream = await capture(options);
    if (!state.routed) {
      return stream;
    }

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
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    });
    for (const track of audio.getAudioTracks()) stream.addTrack(track);
    return stream;
  };
}

async function serve(body, port) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, {"content-type": "text/html"});
      response.end(body);
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// Chromium's own fake devices, so this needs no hardware. "Fake Audio Input 1"
// stands in for the "Consort share (application only)" source.
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

const inject = (routed) =>
  `(${attachSharedAudio.toString()})("Fake Audio", ${JSON.stringify(routed)})`;

app.whenReady().then(async () => {
  await serve(OUTER, OUTER_PORT);
  await serve(INNER, INNER_PORT);

  const ses = session.fromPartition("persist:probe");
  ses.setDisplayMediaRequestHandler((request, callback) => {
    void (async () => {
      const [screen] = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: {width: 0, height: 0},
      });
      // Video only, which is the whole problem: on Linux there is nothing to
      // put in `audio` here, and `audio: "loopback"` is Windows-only.
      callback(screen === undefined ? {} : {video: screen});
    })();
  });

  // Exactly the app's wiring: every frame, as it navigates, nothing routed yet.
  app.on("web-contents-created", (_event, contents) => {
    contents.on("did-frame-navigate", (...arguments_) => {
      const [processId, routingId] = arguments_.slice(-2);
      if (contents.session !== ses) return;
      const frame = webFrameMain.fromId(processId, routingId);
      if (frame !== undefined) void frame.executeJavaScript(inject(false));
    });
  });

  const host = new BrowserWindow({
    show: false,
    webPreferences: {webviewTag: true, sandbox: false},
  });
  const attached = new Promise((resolve) => {
    host.webContents.on("did-attach-webview", (_event, guest) =>
      resolve(guest),
    );
  });

  const preload = url.pathToFileURL(path.join(__dirname, "preload.js")).href;
  await host.loadURL(
    "data:text/html," +
      encodeURIComponent(
        `<webview src="http://127.0.0.1:${OUTER_PORT}/" preload="${preload}"` +
          ` partition="persist:probe" allowpopups></webview>`,
      ),
  );

  const guest = await attached;
  const ran = [];
  guest.on("console-message", (event) => {
    if (event.message.startsWith("[preload]")) ran.push(event.message);
  });
  guest.on("preload-error", (_event, script, error) => {
    console.log(`  preload failed to load: ${script}: ${error}`);
  });

  await new Promise((resolve) => guest.once("did-finish-load", resolve));
  // The iframe loads after its parent says it has finished.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const [main, ...rest] = guest.mainFrame.framesInSubtree;
  const inner = rest[0];

  console.log("\n=== what the preload could reach ===");
  for (const message of ran) line("ran", message.replace("[preload] ", ""));
  line("frames in the guest", 1 + rest.length);
  const fromPreload = JSON.parse(
    await main.executeJavaScript(`JSON.stringify({
      patch: navigator.mediaDevices.getDisplayMedia.name,
      marker: typeof window.__consortProbePreloadWorld,
      executeJavaScript: typeof window.__consortProbeExecuteJavaScript,
    })`),
  );
  // Named functions throughout, so that "whose wrapper is this?" is answerable:
  // the preload installs `consortFromPreload`, the main process
  // `consortWrapped`.
  line(
    "page sees the preload's patch",
    fromPreload.patch === "consortFromPreload"
      ? "yes"
      : `no — it has ${fromPreload.patch || "(anonymous)"}`,
  );
  line("page sees the preload's own world", fromPreload.marker);
  line(
    "page sees webFrame.executeJavaScript",
    fromPreload.executeJavaScript === "string" ? "yes" : "no",
  );

  console.log("\n=== what the main process reached, on navigation ===");
  for (const frame of [main, inner]) {
    if (frame === undefined) continue;
    line(
      `${frame === main ? "main frame" : "the iframe"} (${frame.url})`,
      // eslint-disable-next-line no-await-in-loop
      await frame.executeJavaScript(
        "navigator.mediaDevices.getDisplayMedia.name",
      ),
    );
  }

  if (inner === undefined) {
    console.log("  no iframe: nothing further to check");
    app.exit(1);
    return;
  }

  line(
    "the iframe's own code sees",
    await inner.executeJavaScript("probeWrapperName()"),
  );

  // Now the second half: the routing changing, pushed the way the app pushes
  // it — every frame of every WebContents in the session, found from here
  // rather than remembered.
  console.log("\n=== a share starting, told to the frames ===");
  const before = await inner.executeJavaScript("probeShare()", true);
  line("unrouted share carried", before);

  await Promise.all(
    webContents
      .getAllWebContents()
      .filter((contents) => !contents.isDestroyed() && contents.session === ses)
      .flatMap((contents) => contents.mainFrame.framesInSubtree)
      .map(async (frame) => frame.executeJavaScript(inject(true))),
  );

  let outcome;
  try {
    // userGesture, because getDisplayMedia needs a transient activation.
    outcome = await inner.executeJavaScript("probeShare()", true);
  } catch (error) {
    outcome = `THREW: ${error}`;
  }

  line("routed share carried", outcome);

  console.log(
    "\n  Expected: the preload's patch invisible to the page and absent from\n" +
      "  the iframe entirely; both frames wrapped from the main process on\n" +
      "  navigation; no audio track until the routing is pushed, and one\n" +
      "  afterwards with all three kinds of microphone processing off.\n",
  );

  app.exit(0);
});
