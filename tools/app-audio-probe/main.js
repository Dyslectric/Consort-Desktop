// Does Windows process loopback actually capture that application?
//
// Run it before believing anything else about per-application audio. It answers
// the two questions the rest of the feature is built on — whether this machine
// has the API at all, and whether asking for one process's tree really catches
// the sound you can hear — and it answers them as a file you can play, rather
// than as a return code.
//
//   npx electron tools/app-audio-probe/main.js spotify
//   npx electron tools/app-audio-probe/main.js 12345 10
//
// A name is matched against running executables; a number is used as a PID. The
// second argument is seconds, and defaults to five. The WAV lands beside this
// file.
//
// Under Electron rather than node, deliberately: the addon is compiled against
// Electron's ABI, so node cannot load it and a probe that ran there would be
// proving something about a binary we do not ship.
//
// WHAT TO EXPECT: an application playing sound gives a file with sound in it.
// A browser gives every tab that browser is playing, not the one you meant —
// its audio is rendered in a shared process, and no arrangement of these flags
// separates them. Silence with no error is the interesting failure: it means
// the process tree that was asked for is not the one making the noise.

const {execFileSync} = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {app} = require("electron");

const CHANNELS = 2;
const SAMPLE_RATE = 48000;
const BITS = 16;

function resolvePid(target) {
  if (/^\d+$/.test(target)) {
    return Number(target);
  }

  // tasklist rather than a native call: this is a probe, and shelling out is
  // one line against a whole extra binding.
  const csv = execFileSync("tasklist", ["/fo", "csv", "/nh"], {
    encoding: "utf8",
  });
  const wanted = target.toLowerCase().replace(/\.exe$/, "");
  const matches = [];

  for (const line of csv.split(/\r?\n/)) {
    const fields = line.split('","').map((f) => f.replace(/^"|"$/g, ""));
    const [name, pid] = fields;
    if (name && name.toLowerCase().replace(/\.exe$/, "") === wanted) {
      matches.push({name, pid: Number(pid)});
    }
  }

  if (matches.length === 0) {
    throw new Error(`nothing running called ${target}`);
  }

  matches.sort((a, b) => a.pid - b.pid);
  return matches;
}

/**
 Which of an application's processes to point the capture at.

 Not the lowest process id, which is what this asked for first and which is
 nothing better than a guess: ids are handed out in whatever order the system
 has spare and they wrap, so the oldest process of a browser is regularly not
 the one owning the others.

 Windows already knows which processes are playing — it is the list the volume
 mixer draws — so the answer is taken from there instead. Where one of the
 candidates holds an audio session, that is the one making the noise.
 */
function chooseProcess(addon, matches) {
  const playing = new Map(
    addon
      .listAudioSessions()
      .map((session) => [session.processId, session.active]),
  );
  const withAudio = matches.filter((match) => playing.has(match.pid));

  console.log(
    `${matches.length} process(es) called ${matches[0].name}; ` +
      `${withAudio.length} of them hold an audio session`,
  );

  if (withAudio.length === 0) {
    console.log(
      "none of them is playing anything, so this captures the first with its " +
        "process tree — which is what sharing that window would do.",
    );
    return matches[0].pid;
  }

  // An active session ahead of an idle one: a session that has gone inactive is
  // an application that stopped playing, not one that never started.
  const active = withAudio.find((match) => playing.get(match.pid));
  const chosen = active ?? withAudio[0];
  console.log(`capturing pid ${chosen.pid}, which holds one`);
  return chosen.pid;
}

function wavHeader(dataBytes) {
  const header = Buffer.alloc(44);
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS) / 8;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM header size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((CHANNELS * BITS) / 8, 32);
  header.writeUInt16LE(BITS, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

app.whenReady().then(() => {
  const [target, secondsArg] = process.argv.slice(2);
  if (!target) {
    console.error("usage: main.js <process name or pid> [seconds]");
    app.exit(2);
    return;
  }

  const seconds = Number(secondsArg ?? 5);
  const addon = require(
    path.join(__dirname, "../../native/build/Release/consort_app_audio.node"),
  );

  console.log("ActivateAudioInterfaceAsync present:", addon.isSupported());

  const resolved = resolvePid(target);
  const pid = Array.isArray(resolved)
    ? chooseProcess(addon, resolved)
    : resolved;
  const chunks = [];
  const failures = [];
  let silent = 0;

  const capture = new addon.AppAudioCapture();
  capture.start(
    pid,
    true,
    (chunk) => {
      chunks.push(chunk);
      // Counting silence separately is the whole diagnostic value here: a file
      // that is entirely zeroes means the capture worked and the process tree was
      // wrong, which looks identical to a broken capture from the outside.
      if (chunk.every((byte) => byte === 0)) {
        silent += 1;
      }
    },
    (message) => {
      // The reason nothing arrived, which the addon used to keep to itself. A
      // failed activation and an application sitting quietly look the same from
      // out here, and only one of them is worth investigating.
      failures.push(message);
      console.error("capture error:", message);
    },
  );

  console.log(`capturing pid ${pid} for ${seconds}s — play something now`);

  setTimeout(() => {
    capture.stop();

    const data = Buffer.concat(chunks);
    const out = path.join(__dirname, `capture-${pid}.wav`);
    fs.writeFileSync(out, Buffer.concat([wavHeader(data.length), data]));

    console.log(`${chunks.length} buffers, ${silent} of them silent`);
    if (failures.length > 0) {
      console.log(`${failures.length} error(s); the capture never ran`);
    }
    console.log(
      `${(data.length / ((SAMPLE_RATE * CHANNELS * BITS) / 8)).toFixed(1)}s of audio -> ${out}`,
    );
    app.exit(chunks.length > 0 && silent < chunks.length ? 0 : 1);
  }, seconds * 1000);
});
