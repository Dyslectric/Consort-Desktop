import {dialog} from "@electron/remote";

import {html} from "../../../../common/html.ts";
import * as Messages from "../../../../common/messages.ts";
import * as t from "../../../../common/translation-util.ts";
import type {ServerConfig} from "../../../../common/types.ts";
import {generateNodeFromHtml} from "../../components/base.ts";
import {ipcRenderer} from "../../typed-ipc-renderer.ts";
import * as DomainUtil from "../../utils/domain-util.ts";

import {generateSettingOption} from "./base-section.ts";

type ServerInfoFormProperties = {
  $root: Element;
  server: ServerConfig;
  index: number;
  onChange: () => void;
};

export function initServerInfoForm(properties: ServerInfoFormProperties): void {
  const $serverInfoForm = generateNodeFromHtml(html`
    <div class="settings-card">
      <div class="server-info-left">
        <img
          class="server-info-icon"
          src="${DomainUtil.iconAsUrl(properties.server.icon)}"
        />
        <div class="server-info-row">
          <span class="server-info-alias">${properties.server.alias}</span>
          <i class="material-icons open-tab-button">open_in_new</i>
        </div>
      </div>
      <div class="server-info-right">
        <div class="server-info-row server-url">
          <span class="server-url-info" title="${properties.server.url}"
            >${properties.server.url}</span
          >
        </div>
        <div class="server-info-row server-media-permissions">
          <div class="server-media-permission">
            <span>${t.__("Camera")}</span>
            <div
              class="server-media-permission-toggle"
              data-kind="camera"
            ></div>
          </div>
          <div class="server-media-permission">
            <span>${t.__("Microphone")}</span>
            <div
              class="server-media-permission-toggle"
              data-kind="microphone"
            ></div>
          </div>
        </div>
        <div class="server-info-row">
          <div class="action red server-delete-action">
            <span>${t.__("Disconnect")}</span>
          </div>
        </div>
      </div>
    </div>
  `);
  const $serverInfoAlias = $serverInfoForm.querySelector(".server-info-alias")!;
  const $serverIcon = $serverInfoForm.querySelector(".server-info-icon")!;
  const $deleteServerButton = $serverInfoForm.querySelector(
    ".server-delete-action",
  )!;
  const $openServerButton = $serverInfoForm.querySelector(".open-tab-button")!;
  properties.$root.append($serverInfoForm);

  // Per organization, and per device, rather than one switch for the app: an
  // organization you run yourself and one you were invited to are not the same
  // decision, and neither is a microphone and a camera.
  //
  // Undecided reads as off here. That is a small lie — undecided will still
  // prompt, where off never will — but a tri-state switch is a worse lie, and
  // the only action available in either state is the same one.
  const mediaToggles: Array<[DomainUtil.MediaKind, string]> = [
    ["camera", '.server-media-permission-toggle[data-kind="camera"]'],
    ["microphone", '.server-media-permission-toggle[data-kind="microphone"]'],
  ];
  for (const [kind, selector] of mediaToggles) {
    const $toggle = $serverInfoForm.querySelector<HTMLElement>(selector)!;
    const render = () => {
      generateSettingOption({
        $element: $toggle,
        value:
          DomainUtil.getMediaPermission(properties.server.url, kind) ?? false,
        clickHandler() {
          DomainUtil.setMediaPermission(
            properties.server.url,
            kind,
            !(
              DomainUtil.getMediaPermission(properties.server.url, kind) ??
              false
            ),
          );
          render();
        },
      });
    };

    render();
  }

  $deleteServerButton.addEventListener("click", () => {
    (async () => {
      const {response} = await dialog.showMessageBox({
        type: "warning",
        buttons: [t.__("Yes"), t.__("No")],
        defaultId: 0,
        message: t.__("Are you sure you want to disconnect this organization?"),
      });
      if (response === 0) {
        if (DomainUtil.removeDomain(properties.index)) {
          ipcRenderer.send("reload-full-app");
        } else {
          const {title, content} = Messages.orgRemovalError(
            DomainUtil.getDomain(properties.index).url,
          );
          dialog.showErrorBox(title, content);
        }
      }
    })();
  });

  $openServerButton.addEventListener("click", () => {
    ipcRenderer.send("forward-message", "switch-server-tab", properties.index);
  });

  $serverInfoAlias.addEventListener("click", () => {
    ipcRenderer.send("forward-message", "switch-server-tab", properties.index);
  });

  $serverIcon.addEventListener("click", () => {
    ipcRenderer.send("forward-message", "switch-server-tab", properties.index);
  });
}
