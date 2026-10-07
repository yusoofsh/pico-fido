/**
 * F13-F16 → command binding guidance, shared by "doctor" and "install".
 *
 * Shortcuts cannot be authored headlessly, so pipico prints these steps (with
 * absolute executable paths) instead of writing any binding itself.
 *
 * The gesture → key mapping is the firmware's (src/pipico/gesture.c and
 * docs/pipico/): tap → F13, double tap → F14, 1.5-3 s hold → F15,
 * 3-10 s hold → F16. Keep the wording in sync with docs/pipico/.
 */

/** The per-user wrapper install creates; the executable Shortcuts must call. */
export const WRAPPER_RELATIVE = '.local/bin/pipico';

/** The absolute wrapper path install creates and doctor checks. */
export function executablePath(home: string): string {
  return `${home.replace(/\/+$/, '')}/${WRAPPER_RELATIVE}`;
}

export interface BindingMapping {
  key: 'F13' | 'F14' | 'F15' | 'F16';
  gesture: string;
  command: 'action' | 'attention' | 'incident' | 'lock';
}

/** The four bindings, in key order. */
export const BINDINGS: readonly BindingMapping[] = [
  { key: 'F13', gesture: 'single tap on the Pipico button', command: 'action' },
  { key: 'F14', gesture: 'double tap', command: 'attention' },
  { key: 'F15', gesture: 'hold for 1.5-3 s', command: 'incident' },
  { key: 'F16', gesture: 'hold for 3-10 s', command: 'lock' },
];

/** One doctor check line per key; each names the absolute executable. */
export function bindingLines(exePath: string): string[] {
  return BINDINGS.map((b) => `bindings: ${b.key} (${b.gesture}) → ${exePath} ${b.command}`);
}

/** The step-by-step macOS Shortcuts block printed by install. */
export function bindingInstructions(exePath: string): string[] {
  return [
    'macOS Shortcuts bindings (created manually; pipico never writes bindings):',
    '  1. Open the Shortcuts app on the Mac.',
    '  2. For each mapping below, create one shortcut with a single "Run Shell Script"',
    '     action whose body is exactly the absolute executable path shown (arguments',
    '     included), passing no input.',
    `  3. F13 (single tap on the Pipico button) → ${exePath} action`,
    `     F14 (double tap) → ${exePath} attention`,
    `     F15 (hold for 1.5-3 s) → ${exePath} incident`,
    `     F16 (hold for 3-10 s) → ${exePath} lock`,
    '  4. Bind each shortcut to its function key: shortcut details → Add Keyboard',
    '     Shortcut. On laptops, enable "Use F1, F2, etc. keys as standard function',
    '     keys" or hold fn. The bindings are created by hand, not by pipico.',
  ];
}
