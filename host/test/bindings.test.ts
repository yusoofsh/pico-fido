/**
 * F13-F16 Shortcuts binding guidance (VAL-HOST-034): every mapping names the
 * function key, the gesture and the command, and references one absolute
 * executable path — the same path install creates.
 */
import { describe, expect, it } from 'bun:test';
import { BINDINGS, bindingInstructions, bindingLines, executablePath, WRAPPER_RELATIVE } from '../src/bindings.ts';

const EXE = '/Users/yusoof/.local/bin/pipico';

describe('bindings', () => {
  it('executablePath is absolute and ends in .local/bin/pipico', () => {
    expect(executablePath('/Users/yusoof')).toBe('/Users/yusoof/.local/bin/pipico');
    expect(executablePath('/tmp/h')).toBe('/tmp/h/.local/bin/pipico');
    expect(WRAPPER_RELATIVE).toBe('.local/bin/pipico');
  });

  it('maps F13 tap to action, F14 double tap to attention, F15 1.5-3 s hold to incident, F16 3-10 s hold to lock', () => {
    expect(BINDINGS.map((b) => `${b.key}:${b.command}:${b.gesture}`)).toEqual([
      'F13:action:single tap on the Pipico button',
      'F14:attention:double tap',
      'F15:incident:hold for 1.5-3 s',
      'F16:lock:hold for 3-10 s',
    ]);
  });

  it('bindingLines gives one check line per key, each naming the absolute executable', () => {
    const lines = bindingLines(EXE);
    expect(lines).toHaveLength(4);
    for (const [i, key] of ['F13', 'F14', 'F15', 'F16'].entries()) {
      expect(lines[i]).toContain(key);
      expect(lines[i]).toContain(EXE);
      expect(lines[i]).toContain(BINDINGS[i]!.command);
    }
  });

  it('bindingInstructions are step-by-step, absolute, and say the bindings are created manually', () => {
    const lines = bindingInstructions(EXE);
    const text = lines.join('\n');
    expect(text).toContain('manually');
    expect(text).toContain('Shortcuts');
    // Each mapping line references the absolute path (starts with "/", no "~").
    for (const b of BINDINGS) {
      const line = lines.find((l) => l.includes(b.key));
      expect(line).toBeDefined();
      expect(line).toContain(`${EXE} ${b.command}`);
    }
    expect(text).not.toContain('~');
  });
});
