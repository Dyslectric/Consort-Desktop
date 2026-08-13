import process from "node:process";

import {html} from "../../../common/html.ts";
import * as t from "../../../common/translation-util.ts";
import type {ScreenShareSource} from "../../../common/types.ts";

import {generateNodeFromHtml} from "./base.ts";

// Choose what to share, drawn by the app.
//
// Electron hands getDisplayMedia to the application with no picker of its own,
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

  // Only Windows can send the shared window's audio with it. Saying so here
  // beats letting someone share a video and work out from the silence on the
  // other side that the sound was never going.
  const audioNote =
    process.platform === "win32"
      ? html``
      : html`
          <div class="screen-share-note">
            ${t.__("Sound from the shared window is not included.")}
          </div>
        `;

  const $overlay = generateNodeFromHtml(html`
    <div class="screen-share-overlay">
      <div class="screen-share-dialog">
        <div class="screen-share-header">${t.__("Choose what to share")}</div>
        <div class="screen-share-body">
          ${group(t.__("Entire screen"), screens)}
          ${group(t.__("Window"), windows)}
        </div>
        <div class="screen-share-footer">
          ${audioNote}
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
      resolve(sourceId);
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
