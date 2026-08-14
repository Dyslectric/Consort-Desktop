import {clipboard} from "electron/common";
import {
  BrowserWindow,
  type IpcMainEvent,
  type WebContents,
  app,
  desktopCapturer,
  dialog,
  powerMonitor,
  session,
  webContents,
} from "electron/main";
import {Buffer} from "node:buffer";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";

import * as remoteMain from "@electron/remote/main";
import windowStateKeeper from "electron-window-state";

import * as ConfigUtil from "../common/config-util.ts";
import {bundlePath, bundleUrl, publicPath} from "../common/paths.ts";
import * as t from "../common/translation-util.ts";
import type {RendererMessage} from "../common/typed-ipc.ts";
import {
  EVERYTHING_PLAYING,
  type MenuProperties,
  type ShareableApp,
} from "../common/types.ts";

import * as BadgeSettings from "./badge-settings.ts";
import handleExternalLink from "./handle-external-link.ts";
import * as LinuxAudioShare from "./linux-audio-share.ts";
import * as LinuxDisplayAudio from "./linux-display-audio.ts";
import * as AppMenu from "./menu.ts";
import {_getServerSettings, _isOnline, _saveServerIcon} from "./request.ts";
import {sentryInit} from "./sentry.ts";
import {setAutoLaunch} from "./startup.ts";
import {ipcMain, send} from "./typed-ipc-main.ts";

import "gatemaker/electron-setup.js"; // eslint-disable-line import-x/no-unassigned-import

const {GDK_BACKEND} = process.env;

// Initialize sentry for main process
sentryInit();

let mainWindowState: windowStateKeeper.State;

let badgeCount: number;

let isQuitting = false;

// Load this file in main window
const mainUrl = new URL("app/renderer/main.html", bundleUrl).href;

const permissionCallbacks = new Map<number, (grant: boolean) => void>();
let nextPermissionCallbackId = 0;

const displayMediaCallbacks = new Map<
  number,
  (sourceId: string | null) => void
>();
let nextDisplayMediaCallbackId = 0;

// Sending an application's sound with a screen share, on Linux.
//
// Windows asks nothing at all: the `audio: "loopback"` in the display-media
// handler below puts the whole desktop's sound on every share, because the
// sound of the thing you are showing people is part of showing it to them —
// there is no checkbox for it and never has been. Linux is given the same
// behaviour by working the answer out — see LinuxAudioShare.chooseAutomatically
// — and only asks when the machine genuinely cannot tell which of several
// applications was meant.
//
// That question is the one case where the share waits, and it waits on a clock
// as well as on the user: the sound can only be added to a stream that has not
// been handed over yet, so once getDisplayMedia resolves there is nothing left
// to add it to. A share held indefinitely behind a banner somebody has wandered
// away from is still worse than one that starts without sound, so there is a
// deadline — a generous one, since missing it now costs the sound outright.
// There is no microphone to fall back on any more.
const AUDIO_ANSWER_TIMEOUT_MS = 12_000;

let audioAnswer: (() => void) | undefined;

// Whether the last question went unanswered for long enough that the video has
// already gone without its sound. Answering afterwards has to say so: routing
// the audio at that point rearranges the graph for a track nothing will carry,
// and the banner would claim sound was going out when none is.
let audioOfferExpired = false;

/** Release a share waiting on the audio question, if one is. */
function answerAudioOffer(): void {
  const answer = audioAnswer;
  audioAnswer = undefined;
  answer?.();
}

async function waitForAudioAnswer(): Promise<void> {
  return new Promise<void>((resolve) => {
    const deadline = setTimeout(() => {
      audioAnswer = undefined;
      audioOfferExpired = true;
      resolve();
    }, AUDIO_ANSWER_TIMEOUT_MS);

    audioAnswer = () => {
      clearTimeout(deadline);
      resolve();
    };
  });
}

/**
 What the picker starts on.

 One application playing is not a question worth asking; several is, and the
 answer that matches Windows is all of them. The picker is drawn before the
 user has chosen what to share, so unlike the Wayland path this cannot know
 whether a window or a whole screen is coming — which is the other reason to
 offer everything rather than to guess at one.
 */
function suggestedAudioKey(apps: ShareableApp[]): string {
  const [only] = apps;
  if (only === undefined) {
    return "";
  }

  return apps.length === 1 ? only.key : EVERYTHING_PLAYING;
}

/**
 Route the sound that goes with a share, before the video is handed over.

 Returns once there is nothing left to wait for — which for all but the
 ambiguous case is immediately.
 */
async function routeShareAudio(
  page: WebContents,
  source: LinuxAudioShare.SharedSource,
): Promise<void> {
  if (!ConfigUtil.getConfigItem("shareApplicationAudio", true)) {
    return;
  }

  let choice: LinuxAudioShare.AutomaticChoice;
  try {
    choice = await LinuxAudioShare.chooseAutomatically(source);
  } catch (error: unknown) {
    console.error("could not work out which sound to send", error);
    return;
  }

  switch (choice.kind) {
    case "nothing": {
      return;
    }

    case "choice": {
      try {
        const {appName, everything} = await LinuxAudioShare.start(choice.key);
        await LinuxDisplayAudio.setRouted(true);
        // Nobody was asked, so something has to say what is being sent. The
        // banner is the entire disclosure and carries the way to stop it.
        send(page, "audio-share-started", {appName, everything});
      } catch (error: unknown) {
        // The video is worth more than its sound; the share goes on without it.
        console.error("could not send the shared application's sound", error);
      }

      return;
    }

    case "ask": {
      send(page, "offer-audio-share", {apps: choice.apps});
      await waitForAudioAnswer();
    }
  }
}

const appIcon = path.join(publicPath, "resources/Icon");

const iconPath = (): string =>
  appIcon + (process.platform === "win32" ? ".ico" : ".png");

function createMainWindow(): BrowserWindow {
  // Load the previous state with fallback to defaults
  mainWindowState = windowStateKeeper({
    defaultWidth: 1100,
    defaultHeight: 720,
    path: `${app.getPath("userData")}/config`,
  });

  const win = new BrowserWindow({
    // This settings needs to be saved in config
    title: app.name,
    icon: iconPath(),
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 500,
    minHeight: 400,
    webPreferences: {
      preload: path.join(bundlePath, "../preload/renderer.cjs"),
      sandbox: false,
      webviewTag: true,
    },
    show: false,
  });
  remoteMain.enable(win.webContents);

  win.on("focus", () => {
    send(win.webContents, "focus");
  });

  (async () => win.loadURL(mainUrl))();

  // Keep the app running in background on close event
  win.on("close", (event) => {
    if (ConfigUtil.getConfigItem("quitOnClose", false)) {
      app.quit();
    }

    if (!isQuitting) {
      event.preventDefault();

      if (process.platform === "darwin") {
        if (win.isFullScreen()) {
          win.setFullScreen(false);
          win.once("leave-full-screen", () => {
            app.hide();
          });
        } else {
          app.hide();
        }
      } else {
        win.hide();
      }
    }
  });

  win.setTitle(app.name);

  win.on("enter-full-screen", () => {
    send(win.webContents, "enter-fullscreen");
  });

  win.on("leave-full-screen", () => {
    send(win.webContents, "leave-fullscreen");
  });

  //  To destroy tray icon when navigate to a new URL
  win.webContents.on("will-navigate", () => {
    send(win.webContents, "destroytray");
  });

  // Let us register listeners on the window, so we can update the state
  // automatically (the listeners will be removed when the window is closed)
  // and restore the maximized or full screen state
  mainWindowState.manage(win);

  return win;
}

(async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();

  if (process.env.GDK_BACKEND !== GDK_BACKEND) {
    console.warn(
      "Reverting GDK_BACKEND to work around https://github.com/electron/electron/issues/28436",
    );
    if (GDK_BACKEND === undefined) {
      delete process.env.GDK_BACKEND;
    } else {
      process.env.GDK_BACKEND = GDK_BACKEND;
    }
  }

  // Used for notifications on Windows
  app.setAppUserModelId("org.zulip.zulip-electron");

  remoteMain.initialize();

  app.on("second-instance", () => {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.show();
  });

  ipcMain.on(
    "permission-callback",
    (event, permissionCallbackId: number, grant: boolean) => {
      permissionCallbacks.get(permissionCallbackId)?.(grant);
      permissionCallbacks.delete(permissionCallbackId);
    },
  );

  ipcMain.on(
    "display-media-callback",
    (event, displayMediaCallbackId: number, sourceId: string | null) => {
      displayMediaCallbacks.get(displayMediaCallbackId)?.(sourceId);
      displayMediaCallbacks.delete(displayMediaCallbackId);
    },
  );

  // This event is only available on macOS. Triggers when you click on the dock icon.
  app.on("activate", () => {
    mainWindow.show();
  });

  app.on("web-contents-created", (_event, contents: WebContents) => {
    contents.setWindowOpenHandler((details) => {
      handleExternalLink(contents, details, page);
      return {action: "deny"};
    });
  });

  const ses = session.fromPartition("persist:webviewsession");
  ses.setUserAgent(`ZulipElectron/${app.getVersion()} ${ses.getUserAgent()}`);

  // Before any server is loaded, because this wraps getDisplayMedia as each
  // frame arrives and a frame that loaded first would never be wrapped at all.
  LinuxDisplayAudio.install(ses);

  function configureSpellChecker() {
    const enable = ConfigUtil.getConfigItem("enableSpellchecker", true);
    if (enable && process.platform !== "darwin") {
      ses.setSpellCheckerLanguages(
        ConfigUtil.getConfigItem("spellcheckerLanguages", null) ?? [],
      );
    }

    ses.setSpellCheckerEnabled(enable);
  }

  configureSpellChecker();
  ipcMain.on("configure-spell-checker", configureSpellChecker);

  const clipboardSigKey = crypto.randomBytes(32);

  ipcMain.on("new-clipboard-key", (event) => {
    const key = crypto.randomBytes(32);
    const hmac = crypto.createHmac("sha256", clipboardSigKey);
    hmac.update(key);
    event.returnValue = {key, sig: hmac.digest()};
  });

  ipcMain.handle("poll-clipboard", (event, key, sig) => {
    // Check that the key was generated here.
    const hmac = crypto.createHmac("sha256", clipboardSigKey);
    hmac.update(key);
    if (!crypto.timingSafeEqual(sig, hmac.digest())) {
      return;
    }

    try {
      // Check that the data on the clipboard was encrypted to the key.
      const data = Buffer.from(clipboard.readText(), "hex");
      const iv = data.subarray(0, 12);
      const ciphertext = data.subarray(12, -16);
      const authTag = data.subarray(-16);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, {
        authTagLength: 16,
      });
      decipher.setAuthTag(authTag);
      return (
        decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8")
      );
    } catch {
      // If the parsing or decryption failed in any way,
      // the correct token hasn’t been copied yet; try
      // again next time.
      return undefined;
    }
  });

  AppMenu.setMenu({
    tabs: [],
  });
  const mainWindow = createMainWindow();

  // Auto-hide menu bar on Windows + Linux
  if (process.platform !== "darwin") {
    const shouldHideMenu = ConfigUtil.getConfigItem("autoHideMenubar", false);
    mainWindow.autoHideMenuBar = shouldHideMenu;
    mainWindow.setMenuBarVisibility(!shouldHideMenu);
  }

  const page = mainWindow.webContents;

  page.on("dom-ready", () => {
    if (ConfigUtil.getConfigItem("startMinimized", false)) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });

  ipcMain.on("fetch-user-agent", (event) => {
    event.returnValue = session
      .fromPartition("persist:webviewsession")
      .getUserAgent();
  });

  ipcMain.handle("get-server-settings", async (event, domain: string) =>
    _getServerSettings(domain, ses),
  );

  ipcMain.handle("save-server-icon", async (event, url: string) =>
    _saveServerIcon(url, ses),
  );

  ipcMain.handle("is-online", async (event, url: string) =>
    _isOnline(url, ses),
  );

  // Sending an application's sound with a share on Linux. Answers
  // "unavailable" everywhere else, so the renderer can ask unconditionally.
  //
  // The picker starts on the answer the app would have chosen by itself, so
  // that choosing a window and choosing nothing are not the same gesture.
  ipcMain.handle("audio-share-status", async () => {
    if (!ConfigUtil.getConfigItem("shareApplicationAudio", true)) {
      return {kind: "off" as const};
    }

    const status = await LinuxAudioShare.status();
    return status.kind === "ready"
      ? {...status, suggested: suggestedAudioKey(status.apps)}
      : status;
  });

  // The routing can end without anyone pressing anything — the call releases
  // the device, or the shared app exits — and the banner has to follow it.
  LinuxAudioShare.setOnEnded(() => {
    void LinuxDisplayAudio.setRouted(false);
    send(page, "audio-share-ended");
  });

  ipcMain.handle("share-app-audio", async (event, key: string) => {
    if (audioOfferExpired) {
      return {
        ok: false as const,
        message:
          "the share had already started without sound; stop sharing your screen and start again to include it",
      };
    }

    try {
      const {appName, everything} = await LinuxAudioShare.start(key);
      // Before the reply, not after. The page's getDisplayMedia is waiting on
      // the source this reply lets the picker choose, and the wrapper reads the
      // routing the moment that stream resolves; telling it afterwards is a
      // race against the video, lost quietly and only sometimes.
      await LinuxDisplayAudio.setRouted(true);
      answerAudioOffer();
      return {ok: true as const, appName, everything};
    } catch (error: unknown) {
      answerAudioOffer();
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.on("decline-audio-share", () => {
    answerAudioOffer();
  });

  ipcMain.handle("stop-sharing-app-audio", async () => {
    await LinuxAudioShare.stop();
    await LinuxDisplayAudio.setRouted(false);
  });

  app.on(
    "certificate-error",
    (
      event,
      sourceWebContents,
      urlString,
      error,
      certificate,
      callback,
      isMainFrame,
      // eslint-disable-next-line max-params
    ) => {
      if (isMainFrame) {
        const url = new URL(urlString);
        dialog.showErrorBox(
          t.__("Certificate error"),
          t.__(
            "The server presented an invalid certificate for {{{origin}}}:\n\n{{{error}}}",
            {origin: url.origin, error},
          ),
        );
      }
    },
  );

  // Screen sharing. Electron presents no picker of its own for getDisplayMedia,
  // so without this the call's share button fails with nothing to choose from.
  //
  // On Windows, macOS and X11 the picker is drawn by the app, for the same
  // reason the permission banner is: choosing which window to hand over is the
  // consent, and consent a page could draw for itself is worth nothing. It is
  // also why there is no separate "allow screen sharing?" prompt — picking a
  // window *is* the answer, and asking twice for one decision teaches people to
  // click through prompts.
  //
  // On Wayland the desktop already provides exactly that surface, and ours
  // would be the second of the two prompts. See below.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    // A new share, so whatever happened to the last one's question is history.
    audioOfferExpired = false;

    // Bring the capture device into existence now, at the very start of the
    // share, rather than when an application is chosen a few seconds later. The
    // page goes looking for it by label in the moment its stream resolves, with
    // no time to spare, so creating it late means creating one nothing finds.
    // Nothing is routed into it until there is something to route, and it is
    // silent until then.
    //
    // Deliberately not awaited: the share must not wait on the audio graph, and
    // a machine with no PulseAudio simply does nothing here.
    void LinuxAudioShare.ensureDevice().catch((error: unknown) => {
      console.error("could not prepare the audio sharing device", error);
    });

    void (async () => {
      // Wayland does the choosing itself. getSources() opens the desktop's own
      // portal dialog and returns only what the user picked there, so drawing
      // our picker afterwards is a second dialog asking a question that has
      // already been answered — and answering it differently is not even
      // possible, because the portal handed back one source.
      //
      // It is also the better consent surface of the two: it belongs to the
      // desktop rather than to us, and on Wayland it is the only thing that can
      // grant a capture at all.
      const portalChooses =
        process.platform === "linux" &&
        (process.env.XDG_SESSION_TYPE === "wayland" ||
          Boolean(process.env.WAYLAND_DISPLAY));

      let sources;
      try {
        sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          // Thumbnails and icons exist to be drawn in our picker. Under the
          // portal there is no picker to draw them in, and capturing them is
          // not free.
          thumbnailSize: portalChooses
            ? {width: 0, height: 0}
            : {width: 320, height: 200},
          fetchWindowIcons: !portalChooses,
        });
      } catch (error: unknown) {
        console.error("could not enumerate screen sharing sources", error);
        // An empty Streams is how this API says no. Leaving the callback
        // uncalled would hang the page's promise for ever instead.
        callback({});
        return;
      }

      // Audio alongside the video, as far as this reply can carry it.
      //
      // Only Windows, here. Electron's loopback capture is Windows-only, and
      // this reply names a *source* — there is nothing in it that could stand
      // for a PulseAudio device. The ScreenCast portal has no audio of its own
      // to offer either: its source types are monitors, windows and virtual
      // displays, and its streams have no audio fields.
      //
      // Linux gets its audio one layer further in, where the stream is built:
      // linux-display-audio.ts adds the shared application's track to it in the
      // page. See docs/linux-screen-sharing.md.
      //
      // What Windows sends is the whole desktop's output rather than the window
      // that was shared: `loopback` is the only audio this API takes, and it
      // means the default render device. So the setting is the only control
      // there is over it, and until it applied here there was none at all.
      const audio =
        process.platform === "win32" &&
        ConfigUtil.getConfigItem("shareApplicationAudio", true)
          ? {audio: "loopback" as const}
          : {};

      if (portalChooses) {
        const [chosen] = sources;
        if (chosen === undefined) {
          // The portal dialog was dismissed, which is a refusal.
          callback({});
          return;
        }

        // The sound is routed *before* the video is handed over, which is the
        // whole of what used to be missing here. The page's getDisplayMedia
        // resolves the moment this callback runs, and the track can only be
        // added to a stream that has not been handed to the call yet — so
        // granting first and asking afterwards, as this did, meant Wayland
        // could never do more than smuggle the sound in as a microphone.
        //
        // In a `finally`, because a share must not be lost to a failure in its
        // audio — including one nobody thought of.
        try {
          await routeShareAudio(page, {
            kind: chosen.id.startsWith("screen:") ? "screen" : "window",
            name: chosen.name,
          });
        } finally {
          callback({video: chosen, ...audio});
        }

        return;
      }

      const displayMediaCallbackId = nextDisplayMediaCallbackId++;
      displayMediaCallbacks.set(displayMediaCallbackId, (sourceId) => {
        const chosen = sources.find((source) => source.id === sourceId);
        callback(chosen === undefined ? {} : {video: chosen, ...audio});
      });

      send(
        page,
        "display-media-request",
        {
          sources: sources.map((source) => ({
            id: source.id,
            name: source.name,
            kind: source.id.startsWith("screen:")
              ? ("screen" as const)
              : ("window" as const),
            thumbnailDataUrl: source.thumbnail.toDataURL(),
            appIconDataUrl: source.appIcon?.toDataURL(),
          })),
        },
        displayMediaCallbackId,
      );
    })();
  });

  ses.setPermissionRequestHandler(
    (sourceWebContents, permission, callback, details) => {
      const {origin} = new URL(details.requestingUrl);
      const permissionCallbackId = nextPermissionCallbackId++;
      permissionCallbacks.set(permissionCallbackId, callback);
      send(
        page,
        "permission-request",
        {
          webContentsId:
            sourceWebContents.id === mainWindow.webContents.id
              ? null
              : sourceWebContents.id,
          origin,
          permission,
          // Only a media request carries these; the details union does not
          // otherwise have the property at all.
          mediaTypes: "mediaTypes" in details ? (details.mediaTypes ?? []) : [],
        },
        permissionCallbackId,
      );
    },
  );

  // Temporarily remove this event
  // powerMonitor.on('resume', () => {
  // 	mainWindow.reload();
  // 	send(page, 'destroytray');
  // });

  ipcMain.on("focus-app", () => {
    mainWindow.show();
  });

  ipcMain.on("quit-app", () => {
    app.quit();
  });

  // Reload full app not just webview, useful in debugging
  ipcMain.on("reload-full-app", () => {
    mainWindow.reload();
    send(page, "destroytray");
  });

  ipcMain.on("clear-app-settings", () => {
    mainWindowState.unmanage();
    app.relaunch();
    app.exit();
  });

  ipcMain.on("toggle-app", () => {
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
      mainWindow.show();
    } else {
      mainWindow.hide();
    }
  });

  ipcMain.on("toggle-badge-option", () => {
    BadgeSettings.updateBadge(badgeCount, mainWindow);
  });

  ipcMain.on("toggle-menubar", (_event, showMenubar: boolean) => {
    mainWindow.autoHideMenuBar = showMenubar;
    mainWindow.setMenuBarVisibility(!showMenubar);
    send(page, "toggle-autohide-menubar", showMenubar, true);
  });

  ipcMain.on("update-badge", (_event, messageCount: number) => {
    badgeCount = messageCount;
    BadgeSettings.updateBadge(badgeCount, mainWindow);
    send(page, "tray", messageCount);
  });

  ipcMain.on("update-taskbar-icon", (_event, data: string, text: string) => {
    BadgeSettings.updateTaskbarIcon(data, text, mainWindow);
  });

  ipcMain.on(
    "forward-message",
    <Channel extends keyof RendererMessage>(
      _event: IpcMainEvent,
      listener: Channel,
      ...parameters: Parameters<RendererMessage[Channel]>
    ) => {
      send(page, listener, ...parameters);
    },
  );

  ipcMain.on(
    "forward-to",
    <Channel extends keyof RendererMessage>(
      _event: IpcMainEvent,
      webContentsId: number,
      listener: Channel,
      ...parameters: Parameters<RendererMessage[Channel]>
    ) => {
      const contents = webContents.fromId(webContentsId);
      if (contents !== undefined) {
        send(contents, listener, ...parameters);
      }
    },
  );

  ipcMain.on("update-menu", (_event, properties: MenuProperties) => {
    AppMenu.setMenu(properties);
    let activeTab;
    if (
      properties.activeTabIndex !== undefined &&
      (activeTab = properties.tabs[properties.activeTabIndex]) !== undefined
    ) {
      mainWindow.setTitle(`${app.name} - ${activeTab.label}`);
    }
  });

  ipcMain.on("toggleAutoLauncher", (_event, AutoLaunchValue: boolean) => {
    void setAutoLaunch(AutoLaunchValue);
  });

  ipcMain.on(
    "realm-name-changed",
    (_event, serverURL: string, realmName: string) => {
      send(page, "update-realm-name", serverURL, realmName);
    },
  );

  ipcMain.on(
    "realm-icon-changed",
    (_event, serverURL: string, iconURL: string) => {
      send(page, "update-realm-icon", serverURL, iconURL);
    },
  );

  ipcMain.on("save-last-tab", (_event, index: number) => {
    ConfigUtil.setConfigItem("lastActiveTab", index);
  });

  ipcMain.on("focus-this-webview", (event) => {
    send(page, "focus-webview-with-id", event.sender.id);
    mainWindow.show();
  });

  // Update user idle status for each realm after every 15s
  const idleCheckInterval = 15 * 1000; // 15 seconds
  setInterval(() => {
    // Set user idle if no activity in 1 second (idleThresholdSeconds)
    const idleThresholdSeconds = 1; // 1 second
    const idleState = powerMonitor.getSystemIdleState(idleThresholdSeconds);
    if (idleState === "active") {
      send(page, "set-active");
    } else {
      send(page, "set-idle");
    }
  }, idleCheckInterval);
})();

app.on("before-quit", () => {
  isQuitting = true;
});

// Send crash reports
process.on("uncaughtException", (error) => {
  console.error(error);
  console.error(error.stack);
});
