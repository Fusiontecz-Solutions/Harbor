import appLogoLocalSrc from "@/assets/harbor_logo.png";

/** Long logo on light backgrounds. */
export const APP_LOGO_SRC = appLogoLocalSrc;

/** Long logo on dark backgrounds. */
export const APP_LOGO_DARK_SRC = appLogoLocalSrc;

/** Favicon / collapsed sidebar / any small square mark. */
export const APP_SHORT_ICON_SRC = appLogoLocalSrc;

/** Favicon / collapsed sidebar / any small square mark. */
export const APP_SHORT_ICON_DARK_SRC = appLogoLocalSrc;

/** Pick long logo URL for the current theme (sidebar expanded, auth headers, etc.). */
export function resolveAppLogoSrc(_isDark: boolean): string {
  return APP_LOGO_SRC;
}
