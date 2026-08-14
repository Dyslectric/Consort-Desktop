import {z} from "zod";

import {exactPartial} from "./types.ts";

export const dndSettingsSchemata = {
  showNotification: z.boolean(),
  silent: z.boolean(),
  flashTaskbarOnMessage: z.boolean(),
};

export const configSchemata = {
  ...dndSettingsSchemata,
  appLanguage: z.string().nullable(),
  autoHideMenubar: z.boolean(),
  badgeOption: z.boolean(),
  // eslint-disable-next-line @typescript-eslint/naming-convention
  customCSS: z.string().or(z.literal(false)).nullable(),
  dnd: z.boolean(),
  dndPreviousSettings: exactPartial(z.object(dndSettingsSchemata)),
  dockBouncing: z.boolean(),
  downloadsPath: z.string(),
  enableSpellchecker: z.boolean(),
  errorReporting: z.boolean(),
  // Camera and microphone, per organization, keyed by its URL, and kept apart
  // so that one can be allowed without the other. A user preference rather than
  // something the server reports, so it cannot live on ServerConfig — that is
  // refetched from the organization and would overwrite it.
  //
  // An absent entry means *undecided*, which is why these are not booleans with
  // a default: undecided is what raises the prompt, and it has to be
  // distinguishable from a deliberate "no".
  cameraPermissions: z.record(z.string(), z.boolean()),
  lastActiveTab: z.number(),
  microphonePermissions: z.record(z.string(), z.boolean()),
  promptDownload: z.boolean(),
  proxyBypass: z.string(),
  // eslint-disable-next-line @typescript-eslint/naming-convention
  proxyPAC: z.string(),
  proxyRules: z.string(),
  quitOnClose: z.boolean(),
  // Whether a screen share carries sound at all. On by default, because the
  // sound of the thing you are showing people is part of showing it to them —
  // but off is a real answer, and until now there was nowhere to give it on the
  // one platform that has always sent sound.
  //
  // What it governs differs by platform, because what the platforms can send
  // differs: on Linux the application that was shared, routed through
  // PulseAudio; on Windows the whole desktop's output, which is the only thing
  // Electron's loopback capture can offer. macOS sends nothing either way and
  // does not show the setting.
  shareApplicationAudio: z.boolean(),
  showSidebar: z.boolean(),
  spellcheckerLanguages: z.string().array().nullable(),
  startAtLogin: z.boolean(),
  startMinimized: z.boolean(),
  trayIcon: z.boolean(),
  useManualProxy: z.boolean(),
  useProxy: z.boolean(),
  useSystemProxy: z.boolean(),
};
export type ConfigSchemata = typeof configSchemata;

export const enterpriseConfigSchemata = {
  ...configSchemata,
  presetOrganizations: z.string().array(),
};
