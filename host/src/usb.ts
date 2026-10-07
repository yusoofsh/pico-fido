/**
 * The optional doctor check for the USB device named "Yusoofs Pipico".
 * Strictly informational: a not-found result is normal (the key may be
 * unplugged) and never changes doctor's exit code.
 *
 * - Linux/other: scan the sysfs USB device list (plain reads, no root, no
 *   subprocess): the product file of each entry under
 *   /sys/bus/usb/devices/
 * - macOS: one fixed `system_profiler SPUSBDataType` argv through the
 *   shared runner (absolute path, finite timeout, minimal env). Real macOS
 *   execution is NOT_RUN in this mission; the argv shape is test-covered
 *   through an injected spawner.
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { RunOptions, RunResult, SpawnFn } from './exec.ts';

export const PIPICO_USB_PRODUCT = 'Yusoofs Pipico';

export const SYSDIR_DEFAULT = '/sys/bus/usb/devices';
const SYSTEM_PROFILER = '/usr/sbin/system_profiler';
const SYSTEM_PROFILER_TIMEOUT_MS = 10_000;

export type UsbStatus = {
  status: 'found' | 'not-found' | 'skipped';
  detail: string;
};

type ReadDirFn = (dir: string) => string[];
type ReadProductFn = (productFile: string) => string | null;

/** True when text contains the product string (line-tolerant). Pure. */
export function textMentionsProduct(text: string): boolean {
  return text.split('\n').some((line) => line.trim() === PIPICO_USB_PRODUCT || line.includes(PIPICO_USB_PRODUCT));
}

/**
 * Scan one sysfs USB device directory. Injectable reads; a directory that
 * cannot be listed means "skipped", never an error. Pure apart from the
 * injected functions.
 */
export function scanSysfsProducts(
  dir: string,
  readdir: ReadDirFn,
  readProduct: ReadProductFn,
): UsbStatus {
  let entries: string[];
  try {
    entries = readdir(dir);
  } catch (e) {
    return { status: 'skipped', detail: `cannot inspect USB devices: ${String(e instanceof Error ? e.message : e)}` };
  }
  for (const entry of entries) {
    let product: string | null = null;
    try {
      product = readProduct(`${dir}/${entry}/product`);
    } catch {
      product = null; // unreadable per-device file: not fatal
    }
    if (product !== null && textMentionsProduct(product)) {
      return { status: 'found', detail: `device "${PIPICO_USB_PRODUCT}" is present` };
    }
  }
  return { status: 'not-found', detail: `no USB device named "${PIPICO_USB_PRODUCT}" is attached (informational; the key may be unplugged)` };
}

export interface UsbCheckDeps {
  platform?: string;
  sysfsDir?: string;
  readdir?: ReadDirFn;
  readProduct?: ReadProductFn;
  spawn?: SpawnFn;
}

/** The doctor USB check. Never throws; never needs root. */
export async function checkUsbPresence(deps: UsbCheckDeps = {}): Promise<UsbStatus> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin') {
    const spawn = deps.spawn;
    if (spawn === undefined) return { status: 'skipped', detail: 'no spawner available' };
    try {
      const opts: RunOptions = { timeoutMs: SYSTEM_PROFILER_TIMEOUT_MS };
      const result = await spawn([SYSTEM_PROFILER, 'SPUSBDataType'], opts);
      return textMentionsProduct(result.stdout)
        ? { status: 'found', detail: `device "${PIPICO_USB_PRODUCT}" is present` }
        : { status: 'not-found', detail: `no USB device named "${PIPICO_USB_PRODUCT}" is attached (informational; the key may be unplugged)` };
    } catch {
      return { status: 'skipped', detail: 'could not run the USB device listing' };
    }
  }
  if (platform === 'linux') {
    const sysfsDir = deps.sysfsDir ?? SYSDIR_DEFAULT;
    const readdir = deps.readdir ?? ((d: string) => readdirSync(d));
    const readProduct =
      deps.readProduct ?? ((p: string) => {
        // Unreadable per-device product file: treated as no information.
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return null;
        }
      });
    return scanSysfsProducts(sysfsDir, readdir, readProduct);
  }
  return { status: 'skipped', detail: `USB presence is not checked on ${platform}` };
}
