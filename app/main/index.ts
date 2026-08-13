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
import type {MenuProperties} from "../common/types.ts";

import * as BadgeSettings from "./badge-settings.ts";
import handleExternalLink from "./handle-external-link.ts";
import * as LinuxAudioShare from "./linux-audio-share.ts";
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

  // A screen share carries no sound on Linux; these give a call an
  // app's audio as if it were a microphone instead. Empty everywhere
  // else, so the renderer can ask unconditionally.
  ipcMain.handle("list-shareable-audio", async () =>
    (await LinuxAudioShare.isAvailable()) ? LinuxAudioShare.listApps() : [],
  );

  ipcMain.handle("share-app-audio", async (event, streamIndex: string) => {
    try {
      const {deviceDescription, appName} =
        await LinuxAudioShare.start(streamIndex);
      return {ok: true as const, deviceDescription, appName};
    } catch (error: unknown) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle("stop-sharing-app-audio", async () => LinuxAudioShare.stop());

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

      // Audio alongside the video, where the platform can do it at all.
      //
      // Only Windows can. Electron's loopback capture is Windows-only, and on
      // Linux there is nothing to fall back to: the ScreenCast portal carries
      // no audio whatsoever — its source types are monitors, windows and
      // virtual displays, and its streams have no audio fields — so a shared
      // window is silent there no matter what is requested. See
      // docs/linux-screen-sharing.md.
      const audio =
        process.platform === "win32" ? {audio: "loopback" as const} : {};

      if (portalChooses) {
        const [chosen] = sources;
        if (chosen === undefined) {
          // The portal dialog was dismissed, which is a refusal.
          callback({});
          return;
        }

        callback({video: chosen, ...audio});

        // The video is already running; the audio question is asked separately
        // rather than held in front of it, because a share that waits on a
        // second dialog is worse than one that starts and gains sound a moment
        // later.
        void (async () => {
          if (!(await LinuxAudioShare.isAvailable())) {
            return;
          }

          const apps = await LinuxAudioShare.listApps();
          if (apps.length > 0) {
            send(page, "offer-audio-share", {apps});
          }
        })();

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
