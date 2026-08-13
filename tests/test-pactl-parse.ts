import test from "tape";

import {parseSinkInputs} from "../app/main/pactl-parse.ts";

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
    {index: "42", sink: "51", name: "Firefox", processId: "3412"},
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
  t.equal(
    parseSinkInputs(renamed).length,
    0,
    "proves the parser depends on the real property names",
  );
  t.end();
});

test("output with no streams yields nothing", (t) => {
  t.deepEqual(parseSinkInputs(""), [], "empty output");
  t.deepEqual(parseSinkInputs("\n\n"), [], "blank lines only");
  t.end();
});

test("a record without an application name is skipped", (t) => {
  const anonymous = `Sink Input #7
\tSink: 51
\tProperties:
\t\tmedia.name = "Playback"
`;
  t.deepEqual(
    parseSinkInputs(anonymous),
    [],
    "nothing to show a user means nothing to offer",
  );
  t.end();
});
