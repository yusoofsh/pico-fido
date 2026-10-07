import { describe, expect, it } from 'bun:test';
import { checkPath, checkUrl } from '../src/validate.ts';

describe('checkPath', () => {
  const accepted = ['/Users/yusoof/work/infra', '/tmp/a/b', '/a', '/etc/hosts'];

  for (const p of accepted) {
    it(`accepts ${p}`, () => {
      expect(checkPath(p)).toBeNull();
    });
  }

  const rejected: Array<[string, RegExp]> = [
    ['', /empty/],
    ['relative/dir', /absolute/],
    ['./dir', /absolute/],
    ['~/dir', /absolute/],
    ['/home/x/../../etc', /\.\./],
    ['/a/../../../etc/passwd', /\.\./],
    ['/tmp/a/./b', /normalized/],
    ['/a//b', /normalized/],
    ['/a/b/', /normalized/],
    ['a\u0000b', /control/],
    ['/a\nb', /control/],
    ['/a\u001bb', /control/],
    ['\u007f/a', /control/],
  ];

  for (const [p, rx] of rejected) {
    it(`rejects ${JSON.stringify(p)}`, () => {
      const problem = checkPath(p);
      expect(problem).not.toBeNull();
      expect(problem).toMatch(rx);
    });
  }

  it('never echoes the offending path', () => {
    // Control characters would break one-line error reporting.
    expect(checkPath('/x\ny')).not.toContain('/x\ny');
  });
});

describe('checkUrl', () => {
  const accepted = [
    'https://example.com/',
    'https://attention.example/today',
    'http://localhost:3000/',
    'http://localhost/',
    'http://127.0.0.1:8080/x',
    'http://[::1]/',
  ];

  for (const u of accepted) {
    it(`accepts ${u}`, () => {
      expect(checkUrl(u)).toBeNull();
    });
  }

  const rejected: Array<[string, RegExp]> = [
    ['', /empty/],
    ['javascript:alert(1)', /scheme/],
    ['JavaScript:alert(1)', /scheme/],
    [' javascript:alert(1)', /whitespace/],
    ['file:///etc/passwd', /scheme/],
    ['data:text/html,<script>', /scheme/],
    ['vbscript:x', /scheme/],
    ['ftp://example.com', /scheme/],
    ['chrome://settings', /scheme/],
    ['gopher://example.com', /scheme/],
    ['http://example.com/', /localhost/],
    ['http://localhost.evil.com/', /localhost/],
    ['http://127.0.0.1.nip.io/', /localhost/],
    ['http://10.0.0.1/', /localhost/],
    ['http://[fe80::1]/', /localhost/],
    ['https://user:pass@example.com/', /credentials/],
    ['https://user@example.com/', /credentials/],
    ['https://:token@example.com/', /credentials/],
    ['https://a.example/x y', /whitespace/],
    ['https://a.example/\u0007', /whitespace/],
    ['java\tscript:alert(1)', /whitespace/],
    ['not a url', /whitespace/],
    ['ht!tp://x', /parseable/],
    ['https://', /parseable/],
  ];

  for (const [u, rx] of rejected) {
    it(`rejects ${JSON.stringify(u)}`, () => {
      const problem = checkUrl(u);
      expect(problem).not.toBeNull();
      expect(problem).toMatch(rx);
    });
  }

  it('never echoes the offending URL (credentials must stay out of stderr)', () => {
    for (const u of ['https://user:s3cret@example.com/', 'javascript:alert(1)']) {
      expect(checkUrl(u)).not.toContain(u);
      expect(checkUrl(u)).not.toContain('s3cret');
    }
  });
});
