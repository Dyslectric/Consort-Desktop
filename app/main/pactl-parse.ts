// Parsing `pactl list sink-inputs`.
//
// Its own file, with no Electron import, so it can be run against captured
// pactl output without a desktop session. That is not hypothetical tidiness: a
// mechanical rename once turned `application.name` into `app.name` inside these
// patterns, which parses nothing and fails by simply finding no applications —
// a silence indistinguishable from "nothing is playing".

export type SinkInput = {
  index: string;
  sink: string;
  name: string;
  processId: string;
};

// `pactl list short sink-inputs` gives indexes without application names, so
// the long form is parsed. Records are separated by blank lines.
//
// NB: `application.name` and `application.process.id` are PulseAudio's own
// property names in that output. They are not this codebase's identifiers and
// must not be renamed to match its conventions.
export function parseSinkInputs(output: string): SinkInput[] {
  const records: SinkInput[] = [];
  let current: SinkInput | undefined;

  const flush = () => {
    if (current !== undefined && current.name !== "") {
      records.push(current);
    }

    current = undefined;
  };

  for (const line of output.split("\n")) {
    const header = /^Sink Input #(?<index>\d+)/v.exec(line);
    if (header !== null) {
      flush();
      current = {
        index: header.groups!.index!,
        sink: "",
        name: "",
        processId: "",
      };
      continue;
    }

    if (current === undefined) {
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    // "Sink: 51", but not "Sink Latency: ...".
    const sink = /^\s*Sink:\s*(?<sink>\S+)/v.exec(line);
    if (sink !== null) {
      current.sink = sink.groups!.sink!;
      continue;
    }

    const name = /application\.name = "(?<name>.*)"$/v.exec(line.trim());
    if (name !== null) {
      current.name = name.groups!.name!;
      continue;
    }

    const pid = /application\.process\.id = "(?<pid>\d+)"$/v.exec(line.trim());
    if (pid !== null) {
      current.processId = pid.groups!.pid!;
    }
  }

  flush();
  return records;
}
