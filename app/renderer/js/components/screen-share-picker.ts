import process from "node:process";

import {html} from "../../../common/html.ts";
import * as t from "../../../common/translation-util.ts";
import type {ScreenShareSource, ShareableApp} from "../../../common/types.ts";
import {ipcRenderer} from "../typed-ipc-renderer.ts";

import {generateNodeFromHtml} from "./base.ts";

// While an app's sound is routed to a call, something has to say so and
// offer the way back. Nothing else tells the user that their default input has
// been changed, and a rearranged audio graph they cannot see is worse than no
// feature at all.
function showAudioBanner(appName: string, deviceDescription: string) {
  const $banners = document.querySelector("#permission-banners");
  if ($banners === null) {
    return;
  }

  const $banner = generateNodeFromHtml(html`
    <div class="permission-banner">
      <span class="permission-banner-text"
        >${t.__(
          "Sending {{{app}}}'s sound. If the call cannot hear it, choose “{{{device}}}” as the microphone in its audio settings.",
          {
            app: appName,
            device: deviceDescription,
          },
        )}</span
      >
      <div class="permission-banner-actions">
        <button type="button" class="permission-banner-allow">
          ${t.__("Stop sharing sound")}
        </button>
      </div>
    </div>
  `);
  $banners.append($banner);
  $banner
    .querySelector(".permission-banner-allow")!
    .addEventListener("click", () => {
      $banner.remove();
      void ipcRenderer.invoke("stop-sharing-app-audio");
    });
}

/**
 Offer to send an app's sound, with a share already running.
 
 Used on Wayland, where the desktop's own dialog chose the video and the app's
 picker — which carries this choice everywhere else — never appeared.
 */
export function offerAudioShare(apps: ShareableApp[]): void {
  const $banners = document.querySelector("#permission-banners");
  if ($banners === null || apps.length === 0) {
    return;
  }

  const $banner = generateNodeFromHtml(html`
    <div class="permission-banner">
      <span class="permission-banner-text"
        >${t.__(
          "Screen sharing does not carry sound on Linux. Send an app's sound instead?",
        )}</span
      >
      <div class="permission-banner-actions">
        <select class="screen-share-audio-source">
          ${html``.join(
            apps.map(
              (app) => html`
                <option value="${app.index}">${app.name}</option>
              `,
            ),
          )}
        </select>
        <button type="button" class="permission-banner-allow">
          ${t.__("Share sound")}
        </button>
        <button type="button" class="permission-banner-deny">
          ${t.__("No")}
        </button>
      </div>
    </div>
  `);
  $banners.append($banner);

  const $select = $banner.querySelector<HTMLSelectElement>(
    ".screen-share-audio-source",
  )!;
  $banner
    .querySelector(".permission-banner-allow")!
    .addEventListener("click", () => {
      const streamIndex = $select.value;
      $banner.remove();
      void (async () => {
        const result = await ipcRenderer.invoke("share-app-audio", streamIndex);
        if (result.ok) {
          showAudioBanner(result.appName, result.deviceDescription);
        } else {
          showAudioFailure(result.message);
        }
      })();
    });
  $banner
    .querySelector(".permission-banner-deny")!
    .addEventListener("click", () => {
      $banner.remove();
    });
}

function showAudioFailure(message: string) {
  const $banners = document.querySelector("#permission-banners");
  if ($banners === null) {
    return;
  }

  const $banner = generateNodeFromHtml(html`
    <div class="permission-banner">
      <span class="permission-banner-text"
        >${t.__("Could not share the sound: {{{message}}}", {message})}</span
      >
      <div class="permission-banner-actions">
        <button type="button" class="permission-banner-allow">
          ${t.__("Dismiss")}
        </button>
      </div>
    </div>
  `);
  $banners.append($banner);
  $banner
    .querySelector(".permission-banner-allow")!
    .addEventListener("click", () => {
      $banner.remove();
    });
}

// Choose what to share, drawn by the app.
//
// Electron hands getDisplayMedia to the app with no picker of its own,
// so this is not decoration around a browser dialog — it is the only thing
// standing between a page asking for a screen and getting one. That makes it a
// consent surface, and the same rule applies as to the permission banner: a
// chooser the page could draw is a chooser the page could fake, so this one
// lives outside every webview and cannot be reached from inside one.
//
// Dismissing resolves to null rather than never resolving. The page is waiting
// on a promise that only this answer completes, and a cancelled share that
// leaves the call waiting for ever is worse than a refused one.
export async function chooseScreenShareSource(
  sources: ScreenShareSource[],
): Promise<string | null> {
  const $root = document.querySelector("#screen-share-picker");
  if ($root === null) {
    return null;
  }

  const screens = sources.filter((source) => source.kind === "screen");
  const windows = sources.filter((source) => source.kind === "window");

  const tile = (source: ScreenShareSource) => html`
    <button
      type="button"
      class="screen-share-tile"
      data-source-id="${source.id}"
    >
      <img class="screen-share-thumbnail" src="${source.thumbnailDataUrl}" />
      <span class="screen-share-name" title="${source.name}"
        >${source.name}</span
      >
    </button>
  `;

  const group = (title: string, group_sources: ScreenShareSource[]) =>
    group_sources.length === 0
      ? html``
      : html`
          <div class="screen-share-group-title">${title}</div>
          <div class="screen-share-grid">
            ${html``.join(group_sources.map((source) => tile(source)))}
          </div>
        `;

  // Windows sends the shared window's audio with the video. Linux cannot — the
  // ScreenCast portal has no audio at all — so an app's sound is
  // offered separately, routed to the call as if it were a microphone.
  const audio =
    process.platform === "win32"
      ? ({kind: "unavailable"} as const)
      : await ipcRenderer.invoke("audio-share-status");

  const audioSection = (() => {
    switch (audio.kind) {
      case "unavailable": {
        return process.platform === "win32"
          ? html``
          : html`
              <div class="screen-share-note">
                ${t.__("Sound from the shared window is not included.")}
              </div>
            `;
      }

      case "no-output-device": {
        // Distinct from having nothing playing: telling someone to start their
        // audio when the machine has no sound card sends them in circles.
        return html`
          <div class="screen-share-note">
            ${t.__(
              "This machine has no audio output, so there is no sound to share.",
            )}
          </div>
        `;
      }

      case "ready": {
        return audio.apps.length === 0
          ? html`
              <div class="screen-share-note">
                ${t.__(
                  "Sound is not included. Start the audio first to share it.",
                )}
              </div>
            `
          : html`
              <label class="screen-share-audio">
                <span>${t.__("Also share sound from")}</span>
                <select class="screen-share-audio-source">
                  <option value="">${t.__("Nothing")}</option>
                  ${html``.join(
                    audio.apps.map(
                      (app) => html`
                        <option value="${app.index}">${app.name}</option>
                      `,
                    ),
                  )}
                </select>
              </label>
            `;
      }
    }
  })();

  const $overlay = generateNodeFromHtml(html`
    <div class="screen-share-overlay">
      <div class="screen-share-dialog">
        <div class="screen-share-header">${t.__("Choose what to share")}</div>
        <div class="screen-share-body">
          ${group(t.__("Entire screen"), screens)}
          ${group(t.__("Window"), windows)}
        </div>
        <div class="screen-share-footer">
          ${audioSection}
          <button type="button" class="screen-share-cancel">
            ${t.__("Cancel")}
          </button>
        </div>
      </div>
    </div>
  `);
  $root.append($overlay);

  return new Promise<string | null>((resolve) => {
    const answer = (sourceId: string | null) => {
      $overlay.remove();
      document.removeEventListener("keydown", onKeydown);

      // Route the chosen app's sound to the call, but never at the
      // expense of the share itself: if it fails, say so and share the video
      // anyway rather than refusing the whole thing over its audio.
      const $audio = $overlay.querySelector<HTMLSelectElement>(
        ".screen-share-audio-source",
      );
      const streamIndex = sourceId === null ? "" : ($audio?.value ?? "");
      if (streamIndex === "") {
        resolve(sourceId);
        return;
      }

      void (async () => {
        const result = await ipcRenderer.invoke("share-app-audio", streamIndex);
        if (result.ok) {
          showAudioBanner(result.appName, result.deviceDescription);
        } else {
          showAudioFailure(result.message);
        }

        resolve(sourceId);
      })();
    };

    function onKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        answer(null);
      }
    }

    for (const $tile of $overlay.querySelectorAll<HTMLElement>(
      ".screen-share-tile",
    )) {
      $tile.addEventListener("click", () => {
        answer($tile.dataset.sourceId ?? null);
      });
    }

    $overlay
      .querySelector(".screen-share-cancel")!
      .addEventListener("click", () => {
        answer(null);
      });
    // Clicking the backdrop, but not the dialog sitting on it.
    $overlay.addEventListener("click", (event) => {
      if (event.target === $overlay) {
        answer(null);
      }
    });
    document.addEventListener("keydown", onKeydown);
  });
}
