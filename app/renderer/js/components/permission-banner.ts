import {html} from "../../../common/html.ts";
import * as t from "../../../common/translation-util.ts";
import type {MediaKind} from "../utils/domain-util.ts";

import {generateNodeFromHtml} from "./base.ts";

type MediaPermissionRequest = {
  organizationName: string;
  kinds: MediaKind[];
};

function describe(kinds: MediaKind[]): string {
  const camera = kinds.includes("camera");
  const microphone = kinds.includes("microphone");
  if (camera && microphone) {
    return t.__("your camera and microphone");
  }

  return camera ? t.__("your camera") : t.__("your microphone");
}

// Ask, rather than assume, the first time an organization wants a camera or a
// microphone.
//
// Rendered by the app rather than by the organization's page, and deliberately
// so: a prompt drawn inside a webview is a prompt the page controls, and the
// whole value of this one is that it cannot be faked by the thing it is asking
// on behalf of. It wears the sidebar's colours to say the same thing visually.
//
// Returns the kinds the user agreed to, which is not always the whole question:
// when both are asked for, "Allow microphone" is an answer. Electron cannot
// grant half a request — its callback is one boolean — so a partial answer
// refuses the request that prompted it and is remembered, and the page's next
// attempt, for the microphone alone, succeeds without asking again.
export async function askForMediaPermission({
  organizationName,
  kinds,
}: MediaPermissionRequest): Promise<MediaKind[]> {
  const $banners = document.querySelector("#permission-banners");
  if ($banners === null) {
    // No surface to ask on. Refusing is the only safe answer: silently
    // granting would be a camera turned on by a prompt nobody saw.
    return [];
  }

  // Offered only when a camera is part of the question. Letting someone hear you
  // is a smaller concession than letting them see you and the room you are in,
  // and an all-or-nothing prompt makes the smaller one unavailable.
  const bothAsked = kinds.length > 1;
  const partialButtonHtml = bothAsked
    ? html`<button type="button" class="permission-banner-partial">
        ${t.__("Allow microphone")}
      </button>`
    : html``;

  const $banner = generateNodeFromHtml(html`
    <div class="permission-banner">
      <span class="permission-banner-text"
        >${t.__("{{{organization}}} wants to use {{{what}}}", {
          organization: organizationName,
          what: describe(kinds),
        })}</span
      >
      <div class="permission-banner-actions">
        <button type="button" class="permission-banner-deny">
          ${t.__("Deny")}
        </button>
        ${partialButtonHtml}
        <button type="button" class="permission-banner-allow">
          ${bothAsked ? t.__("Allow both") : t.__("Allow")}
        </button>
      </div>
    </div>
  `);
  $banners.append($banner);

  return new Promise<MediaKind[]>((resolve) => {
    const answer = (allowed: MediaKind[]) => {
      $banner.remove();
      resolve(allowed);
    };

    $banner
      .querySelector(".permission-banner-allow")!
      .addEventListener("click", () => {
        answer(kinds);
      });
    $banner
      .querySelector(".permission-banner-partial")
      ?.addEventListener("click", () => {
        answer(["microphone"]);
      });
    $banner
      .querySelector(".permission-banner-deny")!
      .addEventListener("click", () => {
        answer([]);
      });
  });
}
