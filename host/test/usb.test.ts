/**
 * The optional doctor USB presence check for "Yusoofs Pipico": scanning is
 * read-only, never needs root, and reports found / not-found / skipped
 * without ever crashing doctor (VAL-HOST-031, VAL-HOST-032).
 */
import { describe, expect, it } from 'bun:test';
import {
  PIPICO_USB_PRODUCT,
  checkUsbPresence,
  scanSysfsProducts,
} from '../src/usb.ts';
import type { RunOptions, RunResult } from '../src/exec.ts';

describe('scanSysfsProducts (injectable sysfs scan)', () => {
  const dir = '/sys/bus/usb/devices';

  it('finds the product string on a connected device', () => {
    const status = scanSysfsProducts(
      dir,
      () => ['usb1', '1-0:1.0.0', '1-2'],
      (p) => (p === `${dir}/1-2/product` ? 'Yusoofs Pipico\n' : 'hub'),
    );
    expect(status.status).toBe('found');
    expect(status.detail).toContain(PIPICO_USB_PRODUCT);
  });

  it('reports not-found when no device matches', () => {
    const status = scanSysfsProducts(
      dir,
      () => ['usb1', '1-0:1.0.0'],
      () => 'Logitech USB Mouse',
    );
    expect(status.status).toBe('not-found');
  });

  it('reports skipped when the device list cannot be read', () => {
    const status = scanSysfsProducts(dir, () => {
      throw new Error('ENOENT');
    }, () => null);
    expect(status.status).toBe('skipped');
  });

  it('tolerates unreadable per-device product files', () => {
    const status = scanSysfsProducts(
      dir,
      () => ['1-2'],
      () => {
        throw new Error('EIO');
      },
    );
    expect(status.status).toBe('not-found');
  });
});

describe('checkUsbPresence platform selection', () => {
  it('scans sysfs on Linux without spawning anything', async () => {
    let spawns = 0;
    const status = await checkUsbPresence({
      platform: 'linux',
      sysfsDir: '/sys/bus/usb/devices',
      readdir: (d) => (d === '/sys/bus/usb/devices' ? ['1-2'] : []),
      readProduct: (p) => (p.endsWith('/1-2/product') ? 'Yusoofs Pipico' : null),
      spawn: async () => {
        spawns += 1;
        throw new Error('must not spawn on linux');
      },
    });
    expect(spawns).toBe(0);
    expect(status.status).toBe('found');
  });

  it('on macOS uses one fixed system_profiler argv through the runner', async () => {
    const calls: Array<{ argv: readonly string[]; opts: RunOptions }> = [];
    const status = await checkUsbPresence({
      platform: 'darwin',
      spawn: async (argv: readonly string[], opts: RunOptions) => {
        calls.push({ argv, opts });
        return { code: 0, stdout: 'Yusoofs Pipico  (some hub)', stderr: '' } as RunResult;
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual(['/usr/sbin/system_profiler', 'SPUSBDataType']);
    expect(Number.isFinite(calls[0]!.opts.timeoutMs)).toBe(true);
    expect(status.status).toBe('found');
  });

  it('on macOS a profiler failure is skipped, never a crash', async () => {
    const status = await checkUsbPresence({
      platform: 'darwin',
      spawn: async () => {
        throw new Error('spawn failed');
      },
    });
    expect(status.status).toBe('skipped');
  });

  it('on other platforms it is skipped', async () => {
    const status = await checkUsbPresence({ platform: 'freebsd' });
    expect(status.status).toBe('skipped');
  });
});
