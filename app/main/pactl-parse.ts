// Parsing `pactl list sink-inputs`, and sorting what it says into applications.
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
  /** What the stream calls itself: the tab's title, from a browser. */
  mediaName: string;
  /** The module that made it, where one did. Ours are plumbing, not apps. */
  ownerModule: string;
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
  ownerModule: string;
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

/** One application, with everything it is playing. */
export type Group = {
  key: string;
  name: string;
  streams: SinkInput[];
  /** The ones its own naming can tell apart, to be offered separately. */
  named: Array<{key: string; name: string}>;
};

// What a stream is called when it has nothing to say. Matched without case,
// because these are written every way round: Moonlight says "Audio Stream",
// Firefox's own placeholder is "AudioStream", Chromium says "Playback".
const PLACEHOLDER_NAMES = new Set([
  "audiostream",
  "audio stream",
  "playback",
  "playback stream",
  "output",
  "simple client",
  "record stream",
  "sink input",
]);

/**
 What one stream calls itself, where that names anything.

 This is the only per-tab identity there is. A browser puts every tab's audio
 through one process, so nothing else in the audio graph separates them — but
 Firefox names the stream after the page, which is exactly the thing a person
 was looking for in a list of four rows saying "Firefox".
 */
export function streamName(record: SinkInput): string | undefined {
  // "(5) A video on - YouTube": the count in front is the tab's own unread
  // badge, which changes on its own and names nothing.
  const name = record.mediaName.replace(/^\(\d+\)\s*/v, "").trim();
  return name === "" || PLACEHOLDER_NAMES.has(name.toLowerCase())
    ? undefined
    : name;
}

function namedStreams(
  streams: SinkInput[],
): Array<{key: string; name: string}> {
  // One sound needs no picking apart from itself.
  if (streams.length < 2) {
    return [];
  }

  const named = streams.flatMap((stream) => {
    const name = streamName(stream);
    return name === undefined ? [] : [{key: `stream:${stream.index}`, name}];
  });

  // Two sounds called the same thing cannot be told apart by it, so neither is
  // offered: picking one would be a guess wearing the clothes of a choice.
  const times = new Map<string, number>();
  for (const {name} of named) {
    times.set(name, (times.get(name) ?? 0) + 1);
  }

  return named.filter(({name}) => times.get(name) === 1);
}

/**
 The streams sorted into the applications making them.

 A browser is one process making four sounds, not four applications. Every tab
 playing audio is its own sink input, and all of them report the same name and
 the same process, because both browsers put their audio through a single one —
 Chromium's audio service, Firefox's parent. Nothing in the audio graph says
 which tab any of them came from, so offering them separately is offering four
 rows called "Firefox" with no way to tell which is the video you meant.

 The process is the unit instead, and picking it takes all of it.
 */
export function groupByProcess(records: SinkInput[]): Group[] {
  const byKey = new Map<string, SinkInput[]>();
  for (const record of records) {
    // A stream whose process PulseAudio did not name stands alone: there is
    // nothing to say it came from the same application as any other.
    //
    // The name goes in the key beside the process, because a process id is only
    // unique inside its own namespace — a containerised application reports the
    // id it has in there, and Moonlight in a Flatpak calls itself pid 2. Two of
    // those would otherwise collapse into one row.
    const key =
      record.processId === ""
        ? `stream:${record.index}`
        : `pid:${record.processId}:${record.name}`;
    byKey.set(key, [...(byKey.get(key) ?? []), record]);
  }

  return [...byKey].map(([key, streams]) => ({
    key,
    named: namedStreams(streams),
    // The first stream's name, which is every stream's for anything that sets
    // an application name at all. Where they disagree it is because none of
    // them had one and each fell back to what it is playing, and one of those
    // names the application about as well as another.
    name: streams[0]!.name,
    streams,
  }));
}

/**
 One sink's index out of `pactl list short sinks`, by name.

 Needed because a sink input reports the sink it is on by index, and the sink
 this app makes is known to it by name.
 */
export function parseSinkIndex(
  output: string,
  name: string,
): string | undefined {
  for (const line of output.split("\n")) {
    // "51\tconsort-share\tmodule-null-sink.c\ts16le 2ch 44100Hz\tIDLE"
    const [index, found] = line.split("\t");
    if (found === name && index !== undefined && /^\d+$/v.test(index)) {
      return index;
    }
  }

  return undefined;
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
          mediaName: current.mediaName,
          ownerModule: current.ownerModule,
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
        ownerModule: "",
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

    // "Owner Module: 1419", or "n/a" for anything an application made itself.
    const owner = /^\s*Owner Module:\s*(?<module>\d+)/v.exec(line);
    if (owner !== null) {
      current.ownerModule = owner.groups!.module!;
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
