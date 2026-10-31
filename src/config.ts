import type { Viewport } from "./types.js";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";

export const DEFAULT_VIEWPORTS: readonly Viewport[] = [
  { name: "iphone-se", width: 375, height: 667, dpr: 2, mobile: true, userAgent: IPHONE_UA },
  { name: "iphone-15", width: 390, height: 844, dpr: 3, mobile: true, userAgent: IPHONE_UA },
  { name: "pixel-7", width: 412, height: 915, dpr: 2.625, mobile: true, userAgent: ANDROID_UA },
  { name: "iphone-15-pro-max", width: 430, height: 932, dpr: 3, mobile: true, userAgent: IPHONE_UA },
  { name: "desktop", width: 1440, height: 900, dpr: 2, mobile: false },
  { name: "desktop-1280", width: 1280, height: 800, dpr: 1, mobile: false },
];
