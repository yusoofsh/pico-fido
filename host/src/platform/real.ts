/**
 * RealPlatform performs the macOS actions (open -a, open <url>, an osascript
 * chooser, the native lock action). On every other host it refuses every
 * operation with "unsupported platform" before doing anything: no subprocess
 * is spawned and no file is written.
 *
 * The macOS bodies land with the m4 handlers feature; until then they refuse
 * with an explicit not-implemented error rather than pretending. They are
 * NOT_RUN on this Linux VM either way.
 */
import { UnsupportedPlatformError, type Platform } from './index.ts';

export class RealPlatform implements Platform {
  readonly name = 'real';

  get supported(): boolean {
    return process.platform === 'darwin';
  }

  private requireMac(op: string): void {
    if (process.platform !== 'darwin') {
      throw new UnsupportedPlatformError(
        `unsupported platform: ${process.platform} (${op} acts only on macOS; set PIPICO_PLATFORM=fake for testing)`,
      );
    }
    throw new Error(`${op}: macOS execution is not implemented yet (NOT_RUN; see host/README.md "Platform status")`);
  }

  async openApp(_appId: string, _targetPath?: string): Promise<void> {
    this.requireMac('openApp');
  }

  async openUrl(_url: string): Promise<void> {
    this.requireMac('openUrl');
  }

  async choose(_prompt: string, _options: string[]): Promise<string | null> {
    this.requireMac('choose');
    return null;
  }

  async lock(): Promise<void> {
    this.requireMac('lock');
  }
}
