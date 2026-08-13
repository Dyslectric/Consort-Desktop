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
  /** Best available human name: see `displayName`. */
  name: string;
  processId: string;
};

// `pactl list short sink-inputs` gives indexes without application names, so
// the long form is parsed. Records are separated by blank lines.
//
// NB: `application.name` and `application.process.id` are PulseAudio's own
// property names in that output. They are not this codebase's identifiers and
// must not be renamed to match its conventions.
// Not every stream sets application.name. Media players started from a desktop
// file often do; something launched from a shell, or playing through a
// framework that does not bother, may set only its binary or the name of what
// it is playing. Requiring application.name meant those applications simply
// never appeared in the list, with nothing to say why.
type Candidate = {
  index: string;
  sink: string;
  processId: string;
  applicationName: string;
  binary: string;
  mediaName: string;
};

function displayName(candidate: Candidate): string {
  if (candidate.applicationName !== "") {
    return candidate.applicationName;
  }

  if (candidate.binary !== "") {
    // "/usr/bin/mpv" is not a name anyone would recognise; "mpv" is.
    const base = candidate.binary.split("/").pop() ?? candidate.binary;
    return base;
  }

  return candidate.mediaName;
}

export function parseSinkInputs(output: string): SinkInput[] {
  const records: SinkInput[] = [];
  let current: Candidate | undefined;

  const flush = () => {
    if (current !== undefined) {
      const name = displayName(current);
      if (name !== "") {
        records.push({
          index: current.index,
          sink: current.sink,
          name,
          processId: current.processId,
        });
      }
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
        processId: "",
        applicationName: "",
        binary: "",
        mediaName: "",
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

    const trimmed = line.trim();

    const name = /^application\.name = "(?<name>.*)"$/v.exec(trimmed);
    if (name !== null) {
      current.applicationName = name.groups!.name!;
      continue;
    }

    const binary = /^application\.process\.binary = "(?<binary>.*)"$/v.exec(
      trimmed,
    );
    if (binary !== null) {
      current.binary = binary.groups!.binary!;
      continue;
    }

    const media = /^media\.name = "(?<media>.*)"$/v.exec(trimmed);
    if (media !== null) {
      current.mediaName = media.groups!.media!;
      continue;
    }

    const pid = /^application\.process\.id = "(?<pid>\d+)"$/v.exec(trimmed);
    if (pid !== null) {
      current.processId = pid.groups!.pid!;
    }
  }

  flush();
  return records;
}
