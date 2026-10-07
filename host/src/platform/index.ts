/**
 * Platform abstraction. The CLI performs machine actions only through this
 * interface:
 *
 * - FakePlatform (src/platform/fake.ts), selected only by PIPICO_PLATFORM=fake,
 *   records the calls it would have made.
 * - RealPlatform (src/platform/real.ts) performs the macOS actions and refuses
 *   every operation on any other host with "unsupported platform", without
 *   doing anything at all.
 */
import { UsageError } from '../errors.ts';
import { FakePlatform } from './fake.ts';
import { RealPlatform } from './real.ts';

export interface Platform {
  readonly name: string;
  /** False on hosts where real execution is unsupported (everything but macOS). */
  readonly supported: boolean;
  /** Open an allowlisted app, optionally aimed at a validated local path. */
  openApp(appId: string, targetPath?: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  /** Show a chooser; resolves with the picked option id, or null on cancel. */
  choose(prompt: string, options: string[]): Promise<string | null>;
  /** The native lock action. Never reverses a lock and never changes auth settings. */
  lock(): Promise<void>;
  /**
   * Launch an allowlisted agent (by name; fixed argv from src/agents.ts)
   * with the given validated directory as its working directory.
   */
  launchAgent(agent: string, cwd: string): Promise<void>;
}

/** Thrown by the real platform on non-macOS hosts. */
export class UnsupportedPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedPlatformError';
  }
}

/** Thrown by FakePlatform when the fake contract is violated or a fail is forced. */
export class FakePlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakePlatformError';
  }
}

export function getPlatform(env: Record<string, string | undefined>): Platform {
  const value = env.PIPICO_PLATFORM;
  if (value === undefined || value === '') return new RealPlatform();
  if (value === 'fake') return new FakePlatform(env);
  throw new UsageError(
    `unknown PIPICO_PLATFORM value ${JSON.stringify(value)} (supported: unset for the real platform, or "fake")`,
  );
}

export interface PlatformSelection {
  readonly kind: 'real' | 'fake' | 'unknown';
  readonly supported: boolean;
  readonly name: string;
  /** Human message when unsupported (real host is not macOS, unknown value). */
  readonly problem?: string;
}

/**
 * Which platform WOULD be selected, without constructing it. doctor uses
 * this to stay read-only: constructing FakePlatform would truncate
 * PIPICO_FAKE_LOG, which is a write; doctor must never write.
 */
export function describePlatformSelection(env: Record<string, string | undefined>): PlatformSelection {
  const value = env.PIPICO_PLATFORM;
  if (value === 'fake') return { kind: 'fake', supported: true, name: 'fake' };
  if (value === undefined || value === '') {
    if (process.platform === 'darwin') return { kind: 'real', supported: true, name: 'mac' };
    return {
      kind: 'real',
      supported: false,
      name: 'mac',
      problem: `unsupported platform: ${process.platform} (pipico performs actions only on macOS; set PIPICO_PLATFORM=fake for testing)`,
    };
  }
  return {
    kind: 'unknown',
    supported: false,
    name: value,
    problem: `unknown PIPICO_PLATFORM value ${JSON.stringify(value)} (supported: unset for the real platform, or "fake")`,
  };
}

export { FakePlatform, RealPlatform };
