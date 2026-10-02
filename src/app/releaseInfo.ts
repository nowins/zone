declare const __ZONE_BUILD_ID__: string;
declare const __ZONE_RELEASE_LINKS__: Record<string, string>;

export const APP_VERSION = "1.0.0";
export const APP_BUILD_ID = typeof __ZONE_BUILD_ID__ === "string" ? __ZONE_BUILD_ID__ : "local";
export const RELEASE_LINKS: { website?: string; support?: string; privacy?: string; download?: string } =
  typeof __ZONE_RELEASE_LINKS__ === "object" ? __ZONE_RELEASE_LINKS__ : {};
