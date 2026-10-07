import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import {
  AGENT_ALLOWLIST,
  APP_ALLOWLIST,
  ConfigError,
  loadConfig,
  validateConfig,
} from '../src/config.ts';
import {
  makeTempHome,
  VALID_CONFIG,
  writeConfigFile,
  writeDefaultConfig,
  type AnyConfig,
} from './helpers.ts';

function expectSingleError(raw: unknown, rx: RegExp): ConfigError {
  let caught: unknown;
  try {
    validateConfig(raw);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  const err = caught as ConfigError;
  expect(err.errors.length).toBeGreaterThanOrEqual(1);
  const first = err.errors[0] as string;
  expect(first).toMatch(rx);
  return err;
}

describe('validateConfig', () => {
  it('accepts the documented example config', () => {
    const cfg = validateConfig(JSON.parse(JSON.stringify(VALID_CONFIG)));
    expect(cfg.attentionUrl).toBe('https://attention.example/today');
    expect(Object.keys(cfg.workspaces).sort()).toEqual(['devops', 'study']);
    expect(cfg.workspaces.devops?.app).toBe('com.apple.Terminal');
    expect(cfg.incident.notesRoot).toBe('/Users/yusoof/incident-notes');
    expect(cfg.incident.monitoringUrls).toEqual(['https://status.example/internal']);
    expect(cfg.study.urls).toEqual(['https://course.example/lesson-1']);
  });

  it('rejects a JSON array at the top level', () => {
    expectSingleError([], /top level must be a JSON object/);
  });

  it('rejects null, strings and numbers at the top level', () => {
    for (const raw of [null, 'x', 3, true]) {
      expectSingleError(raw, /top level must be a JSON object/);
    }
  });

  const unknownKeyCases: Array<[string, (cfg: AnyConfig) => void, RegExp]> = [
    ['top', (c) => { c.extra = 1; }, /^config: unknown key "extra"/],
    ['workspace', (c) => { c.workspaces.devops.extra = 1; }, /^config\.workspaces\.devops: unknown key "extra"/],
    ['incident', (c) => { c.incident.extra = 1; }, /^config\.incident: unknown key "extra"/],
    ['study', (c) => { c.study.extra = 1; }, /^config\.study: unknown key "extra"/],
  ];

  for (const [level, mutate, rx] of unknownKeyCases) {
    it(`rejects an unknown key at the ${level} level, naming the key path`, () => {
      const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
      mutate(cfg);
      expectSingleError(cfg, rx);
    });
  }

  // VAL-HOST-007: an unknown key that decodes to a control character (the
  // JSON source only ever shows it escaped) must be rendered with the
  // echoSafe rules: every C0/DEL byte becomes "?", so the diagnostic cannot
  // inject terminal controls or split into several lines, while the schema
  // field path stays readable.
  const controlKeys: Array<[string, string, string]> = [
    ['newline', '\n', '?'],
    ['escape', '\u001b[31m', '?[31m'],
    ['nul', '\u0000', '?'],
    ['tab', '\t', '?'],
    ['carriage return', '\r', '?'],
    ['delete', '\u007f', '?'],
  ];
  const controlLevels: Array<[string, (cfg: AnyConfig, key: string) => void, RegExp]> = [
    ['top', (c, k) => { c[k] = 1; }, /^config: unknown key "/],
    ['workspace', (c, k) => { c.workspaces.devops[k] = 1; }, /^config\.workspaces\.devops: unknown key "/],
    ['incident', (c, k) => { c.incident[k] = 1; }, /^config\.incident: unknown key "/],
    ['study', (c, k) => { c.study[k] = 1; }, /^config\.study: unknown key "/],
  ];

  for (const [level, mutate, scopeRx] of controlLevels) {
    for (const [name, key, rendered] of controlKeys) {
      it(`renders an unknown key decoding to ${name} at the ${level} level control-free and on one line`, () => {
        const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
        mutate(cfg, key);
        let caught: unknown;
        try {
          validateConfig(cfg);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        const first = (caught as ConfigError).errors[0] as string;
        // The readable scope/key path is retained and names the key...
        expect(first).toMatch(scopeRx);
        expect(first).toContain(`unknown key "${rendered}"`);
        // ...on exactly one line with no raw C0/DEL byte anywhere.
        expect(first.split('\n')).toHaveLength(1);
        for (const ch of first) {
          const cp = ch.codePointAt(0)!;
          if (cp <= 0x1f || cp === 0x7f) {
            throw new Error(`raw control byte 0x${cp.toString(16).padStart(2, '0')} in diagnostic: ${JSON.stringify(first)}`);
          }
        }
      });
    }
  }

  const dangerousKeys = ['shell', 'command', 'shell_command', 'cmd', 'exec', 'script', 'args'];
  const dangerousLocations: Array<[string, (cfg: AnyConfig, key: string) => void]> = [
    ['top level', (c, k) => { c[k] = 'touch /tmp/pwned'; }],
    ['workspace', (c, k) => { c.workspaces.devops[k] = 'touch /tmp/pwned'; }],
    ['incident', (c, k) => { c.incident[k] = 'touch /tmp/pwned'; }],
  ];

  for (const key of dangerousKeys) {
    for (const [level, mutate] of dangerousLocations) {
      it(`rejects "${key}" at the ${level} (pipico never runs commands from config)`, () => {
        const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
        mutate(cfg, key);
        const err = expectSingleError(cfg, new RegExp(`key "${key}" is not allowed`));
        expect(err.errors[0]).toMatch(/never runs/);
      });
    }
  }

  it('rejects app ids outside the allowlist', () => {
    for (const app of ['com.evil.Payload', '/bin/sh', 'Terminal; rm -rf ~']) {
      const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
      cfg.workspaces.devops.app = app;
      expectSingleError(cfg, /devops\.app: app id .* is not allowlisted/);
    }
  });

  it('accepts every allowlisted app id', () => {
    for (const app of APP_ALLOWLIST) {
      const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
      cfg.workspaces.devops.app = app;
      expect(validateConfig(cfg).workspaces.devops?.app).toBe(app);
    }
  });

  it('rejects a non-string app field', () => {
    const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
    cfg.workspaces.devops.app = 42;
    expectSingleError(cfg, /devops\.app: must be a string/);
  });

  it('rejects agent names outside the allowlist', () => {
    for (const agent of ['sh', 'echo hi', 'claude --dangerously-skip-permissions']) {
      const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
      cfg.workspaces.devops.agent = agent;
      expectSingleError(cfg, /devops\.agent: .*allowlisted agent name/);
    }
  });

  it('accepts every allowlisted agent name', () => {
    for (const agent of AGENT_ALLOWLIST) {
      const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
      cfg.workspaces.devops.agent = agent;
      expect(validateConfig(cfg).workspaces.devops?.agent).toBe(agent);
    }
  });

  it('rejects the workspace id "__proto__"', () => {
    const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
    // Assignment via cfg.workspaces['__proto__'] would hit the setter; JSON
    // parsing (the real path) produces an own enumerable property instead.
    Object.defineProperty(cfg.workspaces, '__proto__', {
      value: cfg.workspaces.devops,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expectSingleError(cfg, /workspace id/);
  });

  const badWorkspaceIds = ['bad id', 'a/b', '', 'a'.repeat(65), ' LeadingSpace'];
  for (const id of badWorkspaceIds) {
    it(`rejects the workspace id ${JSON.stringify(id.length > 20 ? `${id.slice(0, 10)}...` : id)}`, () => {
      const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
      cfg.workspaces[id] = cfg.workspaces.devops;
      expectSingleError(cfg, /workspace id/);
    });
  }

  it('accepts reasonable workspace ids', () => {
    const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
    cfg.workspaces['dev.team-1'] = cfg.workspaces.devops;
    expect(Object.keys(validateConfig(cfg).workspaces).sort()).toEqual(['dev.team-1', 'devops', 'study']);
  });

  it('rejects missing required top-level keys', () => {
    for (const key of ['workspaces', 'attentionUrl', 'incident', 'study']) {
      const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
      delete cfg[key];
      expectSingleError(cfg, new RegExp(`missing required key "${key}"`));
    }
  });

  it('rejects wrong types for top-level sections', () => {
    for (const key of ['workspaces', 'incident', 'study']) {
      const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
      cfg[key] = [];
      expectSingleError(cfg, new RegExp(`config\\.${key}: must be`));
    }
    const cfg2 = JSON.parse(JSON.stringify(VALID_CONFIG));
    cfg2.attentionUrl = 3;
    expectSingleError(cfg2, /config\.attentionUrl: must be a string/);
  });

  const badPaths = ['relative/dir', './dir', '~/dir', '', '/home/x/../../etc', '/tmp/a/./b', 'a\u0000b', '/a\nb'];
  for (const p of badPaths) {
    it(`rejects the workspace path ${JSON.stringify(p.length > 20 ? p.slice(0, 12) : p)}`, () => {
      const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
      cfg.workspaces.devops.paths = [p];
      expectSingleError(cfg, /devops\.paths\[0\]: /);
    });
  }

  it('rejects non-array or non-string paths and urls', () => {
    const cases: Array<(cfg: AnyConfig) => void> = [
      (c) => { c.workspaces.devops.paths = 'not-an-array'; },
      (c) => { c.workspaces.devops.paths = [3]; },
      (c) => { c.workspaces.devops.urls = 'not-an-array'; },
      (c) => { c.incident.monitoringUrls = [null]; },
      (c) => { c.study.urls = {}; },
    ];
    for (const mutate of cases) {
      const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
      mutate(cfg);
      expect(() => validateConfig(cfg)).toThrow(ConfigError);
    }
  });

  const badUrls = [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>',
    'http://example.com/',
    'http://localhost.evil.com/',
    'https://user:pass@example.com/',
  ];
  for (const u of badUrls) {
    it(`rejects ${JSON.stringify(u)} in every URL field`, () => {
      for (const mutate of [
        (c: AnyConfig) => { c.attentionUrl = u; },
        (c: AnyConfig) => { c.workspaces.devops.urls.push(u); },
        (c: AnyConfig) => { c.incident.monitoringUrls.push(u); },
        (c: AnyConfig) => { c.study.urls.push(u); },
      ]) {
        const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
        mutate(cfg);
        expect(() => validateConfig(cfg)).toThrow(ConfigError);
      }
    });
  }

  it('rejects label problems', () => {
    for (const label of ['', 3, 'bad\nlabel']) {
      const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
      cfg.workspaces.devops.label = label;
      expectSingleError(cfg, /devops\.label: /);
    }
  });

  it('rejects a bad incident notesRoot', () => {
    const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
    cfg.incident.notesRoot = '~/notes';
    expectSingleError(cfg, /incident\.notesRoot: /);
  });
});

describe('loadConfig', () => {
  it('loads a valid config from the default location', () => {
    const home = makeTempHome();
    writeDefaultConfig(home);
    const loaded = loadConfig(undefined, { HOME: home });
    expect(loaded.source).toBe('default');
    expect(loaded.path).toBe(`${home}/.config/pipico/config.json`);
    expect(loaded.config.attentionUrl).toBe('https://attention.example/today');
  });

  it('fails cleanly when the default config is missing', () => {
    const home = makeTempHome();
    try {
      loadConfig(undefined, { HOME: home });
      throw new Error('expected ConfigError');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      expect(err.errors).toHaveLength(1);
      expect(err.errors[0]).toMatch(/no config file found/);
      expect(err.errors[0]).toContain(`${home}/.config/pipico/config.json`);
    }
  });

  it('fails cleanly when PIPICO_CONFIG points at a nonexistent file', () => {
    const home = makeTempHome();
    const missing = `${home}/nope.json`;
    try {
      loadConfig(undefined, { HOME: home, PIPICO_CONFIG: missing });
      throw new Error('expected ConfigError');
    } catch (e) {
      const err = e as ConfigError;
      expect(err.errors[0]).toMatch(/config file not found/);
      expect(err.errors[0]).toContain(missing);
    }
  });

  it('fails cleanly on invalid JSON', () => {
    const home = makeTempHome();
    const p = writeConfigFile(home, 'broken.json');
    writeFileSync(p, '{oops');
    try {
      loadConfig(p, { HOME: home });
      throw new Error('expected ConfigError');
    } catch (e) {
      const err = e as ConfigError;
      expect(err.errors).toHaveLength(1);
      expect(err.errors[0]).toMatch(/not valid JSON/);
      expect(err.errors[0]).toContain(p);
    }
  });

  it('fails cleanly on a JSON array config', () => {
    const home = makeTempHome();
    const p = writeConfigFile(home, 'array.json');
    writeFileSync(p, '[]');
    try {
      loadConfig(p, { HOME: home });
      throw new Error('expected ConfigError');
    } catch (e) {
      expect((e as ConfigError).errors[0]).toMatch(/top level must be a JSON object/);
    }
  });

  it('uses the documented precedence: --config over PIPICO_CONFIG over the default', () => {
    const home = makeTempHome();
    const defaultPath = writeDefaultConfig(home, (c) => { c.attentionUrl = 'https://a.example/'; });
    const envPath = writeConfigFile(home, 'b.json', (c) => { c.attentionUrl = 'https://b.example/'; });
    const flagPath = writeConfigFile(home, 'c.json', (c) => { c.attentionUrl = 'https://c.example/'; });

    const onlyDefault = loadConfig(undefined, { HOME: home });
    expect(onlyDefault.source).toBe('default');
    expect(onlyDefault.path).toBe(defaultPath);
    expect(onlyDefault.config.attentionUrl).toBe('https://a.example/');

    const withEnv = loadConfig(undefined, { HOME: home, PIPICO_CONFIG: envPath });
    expect(withEnv.source).toBe('env');
    expect(withEnv.config.attentionUrl).toBe('https://b.example/');

    const withFlag = loadConfig(flagPath, { HOME: home, PIPICO_CONFIG: envPath });
    expect(withFlag.source).toBe('flag');
    expect(withFlag.config.attentionUrl).toBe('https://c.example/');
  });

  it('treats an empty PIPICO_CONFIG as unset', () => {
    const home = makeTempHome();
    writeDefaultConfig(home);
    const loaded = loadConfig(undefined, { HOME: home, PIPICO_CONFIG: '' });
    expect(loaded.source).toBe('default');
  });

  it('fails cleanly when HOME is unset and no override is given', () => {
    try {
      loadConfig(undefined, {});
      throw new Error('expected ConfigError');
    } catch (e) {
      expect((e as ConfigError).errors[0]).toMatch(/HOME is not set/);
    }
  });
});
