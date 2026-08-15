// Compile the native addon against the Electron the app is built with.
//
// Its own script rather than a line in package.json because the Electron
// version has to be read rather than written down: node-gyp needs the exact
// version to fetch headers for, and a number repeated in two places is a number
// that will disagree with itself the first time Electron is bumped.
//
// Not Windows-only. binding.gyp compiles a stub everywhere else, so this runs on
// every platform and leaves behind a module whose start() throws — which is what
// the Linux and macOS builds want, since they have no process loopback to reach
// and their own route to sharing sound.

import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const {version} = require("electron/package.json");
const native = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../native",
);

console.log(`building the app audio addon for Electron ${version}`);

// node-gyp's own entry point, run by this node rather than through npx. Node
// refuses to spawn a .cmd without a shell, and asking for one back would mean
// quoting a path that regularly contains spaces on Windows.
execFileSync(
  process.execPath,
  [
    require.resolve("node-gyp/bin/node-gyp.js"),
    "rebuild",
    `--directory=${native}`,
    "--runtime=electron",
    `--target=${version}`,
    "--dist-url=https://electronjs.org/headers",
    // The app ships x64 only — see the `win` target in package.json — and
    // building for whatever this machine happens to be would produce a binary
    // the packaged app cannot load.
    "--arch=x64",
  ],
  {stdio: "inherit"},
);
