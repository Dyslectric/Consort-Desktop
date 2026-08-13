import {z} from "zod";

// https://github.com/colinhacks/zod/discussions/5983
export const exactPartial = <Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
) =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  z.util.partial(z.ZodExactOptional, schema, undefined) as z.ZodObject<{
    -readonly [K in keyof Shape]: z.ZodExactOptional<Shape[K]>;
  }>;

export type MenuProperties = {
  tabs: TabData[];
  activeTabIndex?: number;
  enableMenu?: boolean;
};

export type NavigationItem =
  | "General"
  | "Network"
  | "AddServer"
  | "Organizations"
  | "Shortcuts";

export type ServerConfig = {
  url: string;
  alias: string;
  icon: string;
  zulipVersion: string;
  zulipFeatureLevel: number;
};

// One thing a user can choose to share: a whole screen, or a single window.
//
// Not Electron's DesktopCapturerSource, which carries a NativeImage and would
// not survive an IPC boundary. Thumbnails are rendered to data URLs in the main
// process, where the sources are enumerated, so the picker only ever handles
// values that can be sent.
export type ScreenShareSource = {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnailDataUrl: string;
  appIconDataUrl?: string | undefined;
};

/** An app currently playing audio, whose sound a call could be given. */
export type ShareableApp = {
  /** PulseAudio sink-input index; stable only for the life of that stream. */
  index: string;
  name: string;
};

export type TabRole = "server" | "function";
export type TabPage = "Settings" | "About";

export type TabData = {
  role: TabRole;
  page?: TabPage | undefined;
  label: string;
  index: number;
};
