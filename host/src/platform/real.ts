/**
 * The real platform is the macOS platform (src/platform/mac.ts). The name
 * RealPlatform is kept for the platform selection in index.ts and the tests.
 * On non-macOS hosts every operation refuses with "unsupported platform"
 * before doing anything (see MacPlatform.requireMac).
 */
export { MacPlatform as RealPlatform, OPEN_TIMEOUT_MS, CHOOSER_TIMEOUT_MS, AGENT_TIMEOUT_MS } from './mac.ts';
