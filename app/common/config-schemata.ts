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
  // Holding a key to speak, with the microphone shut the rest of the time.
  //
  // The gate is in front of the call's own mute button rather than being it —
  // see app/main/mic-gate.ts — so these three say nothing about what any call
  // thinks its mute state is, and turning them off leaves it exactly as it was.
  //
  // Windows only, because watching a key while the app is in the background
  // takes a keyboard hook and only Windows offers one this app can use. The
  // settings are not shown elsewhere.
  pushToTalk: z.boolean(),
  // A physical key, by its DOM `KeyboardEvent.code`, and the modifiers to hold
  // with it. An empty code means none has been chosen, which is distinct from
  // the feature being off: it is the state of having switched it on and not yet
  // said what to press.
  pushToTalkKey: z.object({
    code: z.string(),
    ctrl: z.boolean(),
    shift: z.boolean(),
    alt: z.boolean(),
    meta: z.boolean(),
  }),
  // Whether opening and shutting the gate makes a sound, locally, for the
  // person holding the key. On by default: a gate you cannot hear is one you
  // find out about from the silence after a sentence nobody heard.
  pushToTalkTones: z.boolean(),
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
