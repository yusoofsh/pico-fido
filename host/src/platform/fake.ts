/**
 * FakePlatform records the platform calls the real macOS platform would make.
 *
 * Contract (documented in host/README.md):
 * - Selected only by PIPICO_PLATFORM=fake.
 * - PIPICO_FAKE_LOG=<file>: every call is appended there as one JSON line.
 *   The file is created (truncated) when the platform is constructed, so a
 *   run that records zero calls leaves an empty, existing file.
 * - PIPICO_FAKE_CHOICE=<id|cancel>: answers the chooser. Without it, choose()
 *   throws instead of picking silently.
 * - PIPICO_FAKE_FAIL=<op>: makes that operation fail before recording it.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { agentArgv } from '../agents.ts';
import { FakePlatformError, type Platform } from './index.ts';

export type FakeOp = 'openApp' | 'openUrl' | 'choose' | 'lock' | 'launchAgent';

export interface FakeCall {
  op: FakeOp;
  app?: string;
  path?: string;
  url?: string;
  prompt?: string;
  options?: string[];
  agent?: string;
  argv?: string[];
  cwd?: string;
}

export class FakePlatform implements Platform {
  readonly name = 'fake';
  readonly supported = true;
  /** Calls recorded so far (also written to PIPICO_FAKE_LOG when set). */
  readonly calls: FakeCall[] = [];

  private readonly logPath: string | undefined;
  private readonly choice: string | undefined;
  private readonly failOp: string | undefined;

  constructor(env: Record<string, string | undefined>) {
    this.logPath = env.PIPICO_FAKE_LOG;
    this.choice = env.PIPICO_FAKE_CHOICE;
    this.failOp = env.PIPICO_FAKE_FAIL;
    if (this.logPath !== undefined) {
      try {
        writeFileSync(this.logPath, '');
      } catch (e) {
        throw new Error(`cannot write the fake platform log ${this.logPath}: ${(e as Error).message}`);
      }
    }
  }

  async openApp(appId: string, targetPath?: string): Promise<void> {
    this.failIfForced('openApp');
    const call: FakeCall = { op: 'openApp', app: appId };
    if (targetPath !== undefined) call.path = targetPath;
    this.record(call);
  }

  async openUrl(url: string): Promise<void> {
    this.failIfForced('openUrl');
    this.record({ op: 'openUrl', url });
  }

  async choose(prompt: string, options: string[]): Promise<string | null> {
    this.failIfForced('choose');
    if (this.choice === undefined || this.choice === '') {
      throw new FakePlatformError('choose: no answer available; set PIPICO_FAKE_CHOICE=<id|cancel>');
    }
    this.record({ op: 'choose', prompt, options });
    if (this.choice === 'cancel') return null;
    if (options.includes(this.choice)) return this.choice;
    throw new FakePlatformError(
      `choose: PIPICO_FAKE_CHOICE=${JSON.stringify(this.choice)} is not one of the offered options`,
    );
  }

  async lock(): Promise<void> {
    this.failIfForced('lock');
    this.record({ op: 'lock' });
  }

  async launchAgent(agent: string, cwd: string): Promise<void> {
    this.failIfForced('launchAgent');
    // Record the exact fixed argv the real platform would run, so tests can
    // assert that no auto-approve flag is ever present.
    this.record({ op: 'launchAgent', agent, argv: [...agentArgv(agent)], cwd });
  }

  private failIfForced(op: FakeOp): void {
    if (this.failOp === op) throw new FakePlatformError(`${op}: forced to fail via PIPICO_FAKE_FAIL`);
  }

  private record(call: FakeCall): void {
    this.calls.push(call);
    if (this.logPath !== undefined) appendFileSync(this.logPath, `${JSON.stringify(call)}\n`);
  }
}
