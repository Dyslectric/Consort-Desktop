import test from "tape";

import {
  groupByProcess,
  parseSinkIndex,
  parseSinkInputs,
} from "../app/main/pactl-parse.ts";

// Captured from `pactl list sink-inputs` on PipeWire: three streams, tab
// indentation, properties after the Sink line, and one name with a space in it.
const sample = `Sink Input #42
\tDriver: PipeWire
\tOwner Module: n/a
\tClient: 78
\tSink: 51
\tSample Specification: float32le 2ch 48000Hz
\tCorked: no
\tSink Latency: 21333 usec
\tProperties:
\t\tapplication.name = "Firefox"
\t\tapplication.process.id = "3412"
\t\tapplication.process.binary = "firefox"
\t\tmedia.name = "AudioStream"

Sink Input #43
\tDriver: PipeWire
\tSink: 51
\tSink Latency: 19000 usec
\tProperties:
\t\tapplication.name = "Consort"
\t\tapplication.process.id = "9001"

Sink Input #57
\tDriver: PipeWire
\tSink: 62
\tProperties:
\t\tapplication.name = "mpv Media Player"
\t\tapplication.process.id = "4004"
`;

test("parses every stream out of pactl's long form", (t) => {
  const records = parseSinkInputs(sample);
  t.equal(records.length, 3, "finds all three streams");

  t.deepEqual(
    records[0],
    {
      index: "42",
      sink: "51",
      name: "Firefox",
      processId: "3412",
      mediaName: "AudioStream",
      ownerModule: "",
    },
    "index, sink and name come from the right lines",
  );

  t.equal(
    records[2]!.name,
    "mpv Media Player",
    "a name containing spaces survives intact",
  );
  t.equal(records[2]!.sink, "62", "each record keeps its own sink");
  t.end();
});

test("'Sink Latency:' is not mistaken for 'Sink:'", (t) => {
  // Both records above carry a Sink Latency line after their Sink line; if it
  // matched, the sink would be a duration.
  const records = parseSinkInputs(sample);
  t.equal(records[0]!.sink, "51", "latency did not overwrite the sink");
  t.end();
});

test("the property names are PulseAudio's, not this codebase's", (t) => {
  // A mechanical rename once turned application.name into app.name here, which
  // parses nothing and looks exactly like "no application is playing".
  const renamed = sample.replaceAll("application.", "app.");
  t.deepEqual(
    parseSinkInputs(renamed).map((record) => record.name),
    ["AudioStream"],
    "renaming application.* loses every name it provides, leaving only the " +
      "media.name fallback — so the parser does depend on the real names",
  );

  t.equal(
    parseSinkInputs(
      sample.replaceAll("application.", "app.").replaceAll("media.", "stuff."),
    ).length,
    0,
    "and with media.* renamed as well there is nothing left to find",
  );
  t.end();
});

test("output with no streams yields nothing", (t) => {
  t.deepEqual(parseSinkInputs(""), [], "empty output");
  t.deepEqual(parseSinkInputs("\n\n"), [], "blank lines only");
  t.end();
});

test("a stream with no application.name still gets a name", (t) => {
  // Plenty of streams set only their binary, or only what they are playing.
  // Requiring application.name meant those applications never appeared at all.
  const byBinary = `Sink Input #7
\tSink: 51
\tProperties:
\t\tapplication.process.binary = "/usr/bin/mpv"
\t\tmedia.name = "some-track.opus"
`;
  t.equal(
    parseSinkInputs(byBinary)[0]!.name,
    "mpv",
    "falls back to the binary, without its path",
  );

  const byMedia = `Sink Input #8
\tSink: 51
\tProperties:
\t\tmedia.name = "Playback Stream"
`;
  t.equal(
    parseSinkInputs(byMedia)[0]!.name,
    "Playback Stream",
    "falls back to what is playing when there is nothing better",
  );

  t.end();
});

test("application.name still wins when present", (t) => {
  const both = `Sink Input #9
\tSink: 51
\tProperties:
\t\tapplication.name = "Firefox"
\t\tapplication.process.binary = "/usr/lib/firefox/firefox"
\t\tmedia.name = "AudioStream"
`;
  t.equal(parseSinkInputs(both)[0]!.name, "Firefox", "prefers the real name");
  t.end();
});

// A browser with three tabs playing, a player, and a stream with no process
// named — which is what the list looked like before it was grouped: five rows,
// three of them called "Firefox".
const browser = `Sink Input #42
\tSink: 51
\tProperties:
\t\tapplication.name = "Firefox"
\t\tapplication.process.id = "3412"

Sink Input #43
\tSink: 51
\tProperties:
\t\tapplication.name = "Firefox"
\t\tapplication.process.id = "3412"

Sink Input #44
\tSink: 62
\tProperties:
\t\tapplication.name = "Firefox"
\t\tapplication.process.id = "3412"

Sink Input #57
\tSink: 51
\tProperties:
\t\tapplication.name = "mpv Media Player"
\t\tapplication.process.id = "4004"

Sink Input #61
\tSink: 51
\tProperties:
\t\tmedia.name = "Alarm"
`;

test("every sound one process makes is one row", (t) => {
  const groups = groupByProcess(parseSinkInputs(browser));
  t.equal(groups.length, 3, "a browser, a player, and the nameless stream");

  const [firefox] = groups;
  t.equal(firefox!.name, "Firefox", "named once, not three times");
  t.deepEqual(
    firefox!.streams.map((stream) => stream.index),
    ["42", "43", "44"],
    "and holding all three streams, which is what picking it has to move: " +
      "sending one tab of three is the bug this replaces",
  );
  t.end();
});

test("different processes stay apart", (t) => {
  const groups = groupByProcess(parseSinkInputs(browser));
  t.deepEqual(
    groups.map((group) => group.key),
    ["pid:3412:Firefox", "pid:4004:mpv Media Player", "stream:61"],
    "one key per process, and a stream with no process named keeps its own — " +
      "nothing says it came from the same application as any other",
  );
  t.end();
});

test("a group remembers where each of its streams came from", (t) => {
  // Not one origin for the application: it can be playing to two devices, and
  // putting them all back to the first stream's sink would move one of them
  // somewhere it never was.
  const [firefox] = groupByProcess(parseSinkInputs(browser));
  t.deepEqual(
    firefox!.streams.map((stream) => stream.sink),
    ["51", "51", "62"],
    "each stream's own sink",
  );
  t.end();
});

// Captured from a real session: three Firefox tabs through one process, a
// containerised Moonlight reporting pid 2, and the loopbacks this app makes
// itself, which PulseAudio lists as sink inputs like anything else.
const realSession = `Sink Input #322
\tOwner Module: n/a
\tSink: 51
\tProperties:
\t\tapplication.name = "Firefox"
\t\tapplication.process.id = "1599"
\t\tmedia.name = "(5) YouTube"

Sink Input #384
\tOwner Module: n/a
\tSink: 51
\tProperties:
\t\tapplication.name = "Firefox"
\t\tapplication.process.id = "1599"
\t\tmedia.name = "(5) If this passes, I give up - YouTube"

Sink Input #443
\tOwner Module: n/a
\tSink: 51
\tProperties:
\t\tapplication.name = "Moonlight"
\t\tapplication.process.id = "2"
\t\tmedia.name = "Audio Stream"

Sink Input #458
\tOwner Module: n/a
\tSink: 51
\tProperties:
\t\tapplication.name = "Firefox"
\t\tapplication.process.id = "1599"
\t\tmedia.name = "(5) A video on - YouTube"

Sink Input #1021
\tOwner Module: 1419
\tSink: 51
\tProperties:
\t\tmedia.name = "loopback-1419-13 output"
`;

test("a browser's tabs are offered under it, by their own names", (t) => {
  const [firefox] = groupByProcess(parseSinkInputs(realSession));
  t.equal(firefox!.streams.length, 3, "one process, three sounds");
  t.deepEqual(
    firefox!.named,
    [
      {key: "stream:322", name: "YouTube"},
      {
        key: "stream:384",
        name: "If this passes, I give up - YouTube",
      },
      {key: "stream:458", name: "A video on - YouTube"},
    ],
    "each tab pickable on its own, with the unread count stripped off the " +
      "front — it is the tab's own badge and changes by itself",
  );
  t.end();
});

test("a stream that names nothing is not offered as though it did", (t) => {
  const groups = groupByProcess(parseSinkInputs(realSession));
  const moonlight = groups.find((group) => group.name === "Moonlight");
  t.deepEqual(
    moonlight!.named,
    [],
    "'Audio Stream' is what a client says when it has nothing to say",
  );

  t.deepEqual(
    groupByProcess(parseSinkInputs(browser))[0]!.named,
    [],
    "and neither are three streams that set no media.name at all",
  );
  t.end();
});

test("two sounds called the same thing are not told apart", (t) => {
  // Both tabs on the same video: picking one would be a guess, and the list
  // would be two identical rows again.
  const same = realSession.replaceAll(
    "(5) If this passes, I give up - YouTube",
    "(5) YouTube",
  );
  t.deepEqual(
    groupByProcess(parseSinkInputs(same))[0]!.named,
    [{key: "stream:458", name: "A video on - YouTube"}],
    "the pair drops out and the one that is still unique remains",
  );
  t.end();
});

test("a containerised app does not share a row with another", (t) => {
  // Moonlight in a Flatpak reports pid 2, which is a real pid outside it. The
  // name is in the key so two of those cannot collapse into one row.
  const groups = groupByProcess(parseSinkInputs(realSession));
  t.equal(
    groups.find((group) => group.name === "Moonlight")!.key,
    "pid:2:Moonlight",
    "keyed by process and name together",
  );
  t.end();
});

test("this app's own plumbing is identifiable", (t) => {
  // The loopbacks carrying shared sound to the speakers and to the call are
  // sink inputs too, with no application name and no process — so without the
  // module that made them they reach the list looking like an application
  // called "loopback-1419-13 output".
  const records = parseSinkInputs(realSession);
  const loopback = records.find((record) => record.index === "1021");
  t.equal(loopback!.ownerModule, "1419", "the module that made it");
  t.equal(
    records.find((record) => record.index === "322")!.ownerModule,
    "",
    "and nothing for a stream an application opened itself",
  );
  t.end();
});

test("a sink is found by name in the short listing", (t) => {
  const sinks = `50\talsa_output.pci-0000_00_1f.3.analog-stereo\tmodule-alsa-card.c\ts32le 2ch 48000Hz\tRUNNING
51\tconsort-share\tmodule-null-sink.c\ts16le 2ch 44100Hz\tIDLE
52\tconsort-share-mix\tmodule-null-sink.c\ts16le 2ch 44100Hz\tIDLE
`;
  t.equal(parseSinkIndex(sinks, "consort-share"), "51", "by exact name");
  t.equal(
    parseSinkIndex(sinks, "consort-share-mix"),
    "52",
    "and not by prefix, or the mix would answer for the sink",
  );
  t.equal(parseSinkIndex(sinks, "nothing-called-this"), undefined, "or not");
  t.end();
});

test("a stream with no identifying property at all is skipped", (t) => {
  const anonymous = `Sink Input #10
\tSink: 51
\tProperties:
\t\tmodule-stream-restore.id = "sink-input-by-application-name:"
`;
  t.deepEqual(
    parseSinkInputs(anonymous),
    [],
    "nothing to show a user means nothing to offer",
  );
  t.end();
});
