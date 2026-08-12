import {app} from "electron/main";
import process from "node:process";

import AutoLaunch from "auto-launch";

import * as ConfigUtil from "../common/config-util.ts";

export const setAutoLaunch = async (
  AutoLaunchValue: boolean,
): Promise<void> => {
  // Don't run this in development
  if (!app.isPackaged) {
    return;
  }

  const autoLaunchOption = ConfigUtil.getConfigItem(
    "startAtLogin",
    AutoLaunchValue,
  );

  // `setLoginItemSettings` doesn't support linux
  if (process.platform === "linux") {
    const autoLauncher = new AutoLaunch({
      name: app.name,
      isHidden: false,
    });
    await (autoLaunchOption ? autoLauncher.enable() : autoLauncher.disable());
  } else {
    app.setLoginItemSettings({
      openAtLogin: autoLaunchOption,
      openAsHidden: false,
    });
  }
};
