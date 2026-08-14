// The approach app/main/linux-display-audio.ts rejected, so that the rejection
// can be checked rather than believed: patch getDisplayMedia from the webview
// preload, exactly as one would if contextIsolation were not in the way.
const {webFrame} = require("electron");

console.log(`[preload] ${location.href} (main frame: ${process.isMainFrame})`);

const capture = navigator.mediaDevices.getDisplayMedia.bind(
  navigator.mediaDevices,
);
navigator.mediaDevices.getDisplayMedia = async function consortFromPreload(
  options,
) {
  return capture(options);
};
window.__consortProbePreloadWorld = "the preload's own world";

// The same assignment pushed the other way, which does reach the page — but
// only this frame's page.
void webFrame.executeJavaScript(
  `window.__consortProbeExecuteJavaScript = "the page's world";`,
);
