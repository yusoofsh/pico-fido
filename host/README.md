# pipico — host CLI

The `pipico` host CLI is the per-user macOS companion for the Yusoofs Pipico
FIDO key. The key sends F13–F16; this CLI turns those keys into safe, allow-
listed actions (open a workspace, open a URL, scaffold incident notes, lock
the workstation). It never performs FIDO operations, never talks to the USB
device for credentials, and never runs anything from config.

Status: the CLI is developed and tested on Linux with the fake platform.
**All real macOS execution is NOT_RUN** in this mission (no Mac is attached).

## Running

```sh
cd host
bun src/cli.ts --help        # also: -h, or the "help" command
bun src/cli.ts doctor
```

Requires Bun 1.4.x. Tests: `bun test` (or `bun run test`). Typecheck:
`bunx tsc --noEmit` (or `bun run typecheck`).

## Commands and exit codes

| Command | Purpose |
|---|---|
| `doctor` | Read-only checks: config, bun, platform, installed executable, bindings guidance, optional USB presence of "Yusoofs Pipico" (informational) |
| `action` (F13) | Pick a workspace explicitly and open it — never guesses the terminal cwd |
| `attention` (F14) | Open exactly the configured attention URL |
| `incident` (F15) | Scaffold a timestamped local notes folder and open monitoring pages only |
| `study` | Open the configured study URLs; never submits or answers anything |
| `lock` (F16) | The native macOS lock action; never reverses a lock, never changes auth settings |
| `install` | Per-user install: config skeleton, executable wrapper, manifest — writes only under `$HOME` |
| `uninstall` | Remove only what `pipico install` created (only manifest resources) |

Exit codes: `0` ok (including an explicit chooser cancel, and uninstall with
nothing installed) · `1` error · `2` usage error (includes unknown commands)
· `3` invalid/missing/malformed config · `4` unsupported platform ·
`5` doctor: the installed executable is missing or unusable (run
`pipico install`). `doctor` exits with the first failing check in that
order (3, then 4, then 5).

`--dry-run` is honored by every action handler: it prints the planned
changes on stdout and performs zero platform calls and zero writes.

Unknown commands print `unknown command: <name>` on stderr with the usage and
exit 2 without changing anything.

## Handler behavior

**action (F13).** Shows one explicit chooser offering every configured
workspace id exactly once — never auto-picks, even with a single workspace,
and never looks at the terminal cwd or git state. For each workspace that
configures an allowlisted agent, one additional option `<id>:<agent>` is
offered (e.g. `devops:claude`). Canceling (`PIPICO_FAKE_CHOICE=cancel` or
Esc on macOS) exits 0 and opens nothing. Picking `<id>` runs exactly the
workspace's configured opens (each path as an app-open with that path, then
each URL); a workspace with no paths and no URLs opens the configured app
itself. Picking `<id>:<agent>` does the same opens and then launches the
agent (see "Agent launch" below); a workspace with no paths refuses the
agent choice up front with no opens.

On macOS the chooser's answer is **tagged** by the static AppleScript: a
cancellation returns exactly `pipico-chooser-cancel`, and a selection
returns `pipico-chooser-selected` plus the picked option on the next line.
`MacPlatform` decodes the tag before reading the option, so no schema-valid
workspace id is reserved as a sentinel: a workspace literally named
`CANCELED` (or named exactly like either tag) is accepted and selectable,
and cancelling still opens nothing. The prompt and every option reach
`osascript` only as separate argv items consumed via `on run argv`; nothing
is ever interpolated into the script text.

**incident (F15).** Creates `<notesRoot>/<YYYYMMDD>-<HHMMSS>` (local time,
pattern `^[0-9]{8}-[0-9]{6}$`) containing `notes.md` rendered from the
in-source template, an empty `evidence/` directory and `handoff.md`, then
opens exactly one URL per configured `incident.monitoringUrls` entry, in
order, and records nothing else. The scaffold is never overwritten: an
existing folder of the expected name is a clean refusal (exit 1, zero
platform calls), and all files are written exclusive-create. If a later
monitoring open fails, the exit is nonzero with one short error line and
the already-created folder stays in place. Everything is local only: no
remote access, no restarting/tearing down services, no cleanup, no capture
of history, environment or typed/pasted input.

**study.** Opens exactly the configured `study.urls`, in order. With no
configured URLs it exits 0 with an informational line and zero calls. It
never fills in forms, never submits, never answers and never marks
attendance, and the CLI itself makes no network requests.

**lock (F16).** One platform call of kind `lock` and nothing else. On macOS
the single fixed operation is:

```
/usr/bin/osascript -e 'tell application "System Events" to keystroke "q" using {command down, control down}'
```

That is Apple's documented Control-Command-Q "Lock Screen" shortcut,
dispatched through System Events by a static script. The script text is a
source constant in `src/platform/mac.ts`: no config or user data is ever
interpolated, and there is no fallback. This locks the session immediately
and does not depend on any screensaver or password-delay setting (opening
`ScreenSaverEngine.app` would only start the screen saver, which locks only
if the user's own password-delay settings say so — that is why pipico does
not use it). pipico never reverses a lock and never changes any
authentication or power setting.

Exactly one spawn is attempted: a timeout (60 s bound), a nonzero exit or a
denied permission makes the CLI exit nonzero with one short error line. When
macOS refuses the keystroke, the error names the permission panes to grant
(below); pipico does not retry and does not fall back.

### Lock permissions (macOS prerequisite)

The first real `pipico lock` needs one-time approvals for the app that runs
pipico (Terminal, or whatever hosts the Shortcuts wrapper):

1. **Automation:** System Settings > Privacy & Security > Automation >
   `<host app>` > System Events (allow controlling System Events).
2. **Accessibility:** System Settings > Privacy & Security > Accessibility
   (allow the host app to send keystrokes).

Without them, macOS refuses the keystroke and pipico exits nonzero with one
clear error naming both panes. These grants are per-app and per-user; pipico
never modifies them itself. Real macOS execution of the lock (and of every
other platform action) is NOT_RUN in this mission.

## doctor

`doctor` is strictly read-only: it never writes anything under `$HOME` (it
does not even construct the fake platform, whose constructor truncates the
log), never spawns a subprocess on Linux, and never needs root. It reports
every check instead of stopping at the first problem:

- `config:` loaded through the strict loader (exit 3 on problems; errors go
  to stderr with the key path).
- `bun:` the Bun version this CLI runs on.
- `platform:` `ok` for the fake platform or for macOS; `FAIL` with
  "unsupported platform" on every other host (exit 4), and `FAIL` for an
  unknown `PIPICO_PLATFORM` value.
- `executable:` the per-user wrapper (below) — `ok` when it exists, is a
  regular file and is executable; otherwise `FAIL` (exit 5) naming the path
  and pointing at `pipico install`.
- `bindings:` one line per key mapping F13→`action`, F14→`attention`,
  F15→`incident`, F16→`lock`, each with the absolute wrapper path.
- `usb:` OPTIONAL presence of the USB device named `Yusoofs Pipico`.
  Strictly informational — a not-found or skipped result never changes the
  exit code. On Linux it reads the sysfs device list (no root, no
  subprocess); on macOS it runs one fixed `system_profiler SPUSBDataType`
  argv (NOT_RUN in this mission — no Mac); anywhere else it reports
  `skipped`.

## Install and uninstall

`pipico install` is per-user only. It writes exclusively under `$HOME`
(no sudo, no cron, no launchd — there is no privileged helper and no
scheduler anywhere in the source), never overwrites an existing file, and
records everything it creates in a manifest. `--dry-run` prints the exact
planned changes (absolute paths) and changes nothing; it works on every
host, because install performs no machine actions.

Resources created for `$HOME=/Users/u` (the config base honors
`$XDG_CONFIG_HOME` when set, and refuses to install when that points
outside `$HOME`, is not normalized, or contains a `..`/`.` segment):

| Resource | Mode | Purpose |
|---|---|---|
| `$HOME/.config` | 0755 | created only if absent |
| `$HOME/.config/pipico` | 0755 | created only if absent |
| `$HOME/.config/pipico/config.json` | 0644 | config skeleton (below) |
| `$HOME/.local` | 0755 | created only if absent |
| `$HOME/.local/bin` | 0755 | created only if absent |
| `$HOME/.local/bin/pipico` | 0755 | the wrapper: `#!/usr/bin/env sh` + one `exec '<bun>' '<cli.ts>' "$@"` line pinning the bun binary and the cli.ts it was installed from |
| `$HOME/.config/pipico/installed.json` | 0644 | the manifest (written last) |

**Nested XDG layouts.** When `$XDG_CONFIG_HOME` points at a nested
directory under `$HOME` (for example `$HOME/a/b/config`), every missing
directory between `$HOME` and the base is planned as its own resource —
never a recursive `mkdir`: `--dry-run` lists each missing ancestor
shallowest-first (each before its children), a pre-existing ancestor is
reported as kept instead of newly created, and the manifest records every
directory this invocation actually created. A symbolic link at any planned
directory is refused before anything is created (pipico never writes
through a link).

Policies, all verified by tests:

- **Never overwrites.** An existing config.json, wrapper or any other
  planned target is kept byte-identical, is NOT listed in the manifest, and
  install says it kept it. Install exits 0 either way.
- **Idempotent.** A second run changes nothing (same files, byte-identical
  manifest — it is written only when absent).
- **Ordinary-failure rollback.** If an ordinary caught error strikes
  mid-install (for example `$HOME/.local/bin` exists as a regular file, so
  creating the wrapper fails with ENOTDIR, or the manifest cannot be
  created because `<base>/pipico` is read-only), install exits nonzero with
  a contained error (no stack trace) and reverse-cleans ONLY the resources
  this invocation successfully created: created files are unlinked (the
  creation is recorded before the later chmod, so a chmod failure still
  cleans up), then created directories are removed deepest-first, each only
  when empty (a plain `rmdir`). Pre-existing files and directories — and
  any directory holding something pipico did not create — are kept, never
  deleted. There is no recovery from SIGKILL or power loss and no journal;
  rerunning `install` after such a failure is safe.
- **Manifest.** `installed.json` lists every created file and directory —
  and only those:

  ```json
  {
    "pipicoManifest": 1,
    "createdAt": "2026-10-07T14:31:19.643Z",
    "resources": [
      { "path": "/Users/u/.config", "type": "dir" },
      { "path": "/Users/u/.config/pipico", "type": "dir" },
      { "path": "/Users/u/.config/pipico/config.json", "type": "file",
        "sha256": "<64 hex chars>", "mode": "0644" },
      { "path": "/Users/u/.local", "type": "dir" },
      { "path": "/Users/u/.local/bin", "type": "dir" },
      { "path": "/Users/u/.local/bin/pipico", "type": "file",
        "sha256": "<64 hex chars>", "mode": "0755" }
    ]
  }
  ```

  The manifest is strict like the config: unknown keys anywhere are
  refused. File entries record the SHA-256 of the content at creation time.
  Deleting the manifest leaves installed files in place; uninstall then has
  nothing to remove.

`pipico uninstall` removes exactly the manifest resources and nothing else:

- `--dry-run` prints exactly the manifest entries as planned removals and
  changes nothing (exit 0).
- Without a manifest: nothing is removed and it says so (exit 0).
- Files are unlinked; directories are removed only when empty (`rmdir`), so
  a directory containing user files is never removed.
- Created ancestor directories of a nested XDG base are manifest entries
  like any other: they are removed deepest-first when they end up empty,
  and kept when they are pre-existing or hold user files (as are the
  ancestors still needed to contain them).
- Every entry is validated BEFORE anything is removed. A refused entry
  aborts the whole uninstall (nothing is removed, exit 1, every refusal
  reported). Entries are refused when they are: not absolute or not
  normalized (`..`, `.`, `//`), outside `$HOME` (including `$HOME/../…`),
  HOME itself, a symbolic link (never followed, never removed), of the
  wrong on-disk type, malformed (unknown keys, missing hash on a file
  entry), or a file whose content no longer matches the recorded hash
  (modified after install, or never created by pipico). If you edited a
  pipico-created file and want it gone, delete it yourself.

## Agent launch

Agents are launched only on an explicit chooser pick of the `<id>:<agent>`
option, and only for agent names on the allowlist (`claude`, `codex`,
`aider`). The argv is fixed per name in `src/agents.ts` — currently
`/usr/bin/env <name>` with the workspace's first configured path as the
working directory — and config can never supply a path, argument or flag.
The recorded launch argv therefore never contains an auto-approve flag
(`--yes`, `-y`, `--auto`, `--auto-approve`,
`--dangerously-skip-permissions`, `--skip-permissions-unsafe`,
`--full-auto`) or any other flag. pipico waits for the agent to exit; the
runner's hard stop is 6 hours (finite by design).

## Platform layer and the fake platform

All machine actions go through the `Platform` interface (`src/platform/`).
The real platform acts only on macOS. **On every other host every action
handler exits 4 with "unsupported platform" before doing anything**: no
subprocess is spawned and no file is written. `doctor` is read-only and still
reports config checks on any host.

Tests (and local experiments on Linux) select the fake platform, which
performs nothing and records what it would have done:

| Environment variable | Effect |
|---|---|
| `PIPICO_PLATFORM=fake` | Select `FakePlatform` (the only way to select it) |
| `PIPICO_FAKE_LOG=<file>` | Append every platform call there as one JSON line; the file is created (truncated) at startup, so a run with zero calls leaves an empty file |
| `PIPICO_FAKE_CHOICE=<id\|cancel>` | Answer the chooser with a workspace id, an `<id>:<agent>` agent option, or cancel; without it `choose` fails instead of picking silently |
| `PIPICO_FAKE_FAIL=<op>` | Make the operation `openApp`, `openUrl`, `choose`, `lock` or `launchAgent` fail before recording it |

Example recorded lines:

```
{"op":"openUrl","url":"https://attention.example/today"}
{"op":"openApp","app":"com.apple.Terminal","path":"/Users/yusoof/work/infra"}
{"op":"choose","prompt":"pipico: pick a workspace (cancel opens nothing)","options":["devops","devops:claude","study"]}
{"op":"launchAgent","agent":"claude","argv":["/usr/bin/env","claude"],"cwd":"/Users/yusoof/work/infra"}
{"op":"lock"}
```

## Config

Precedence (highest first), documented per VAL-HOST-016:

1. `--config <path>`
2. `$PIPICO_CONFIG`
3. `$XDG_CONFIG_HOME/pipico/config.json`, or `$HOME/.config/pipico/config.json`
   when `XDG_CONFIG_HOME` is unset

The CLI never creates a config file. A missing, malformed or invalid config
is a clean one-line error and exit 3 (or, for `doctor`, the config check
failing).

Example (this exact shape is used by the test suite):

```json
{
  "workspaces": {
    "devops": {
      "label": "DevOps",
      "app": "com.apple.Terminal",
      "paths": ["/Users/yusoof/work/infra"],
      "urls": ["https://grafana.internal.example/dash"],
      "agent": "claude"
    }
  },
  "attentionUrl": "https://attention.example/today",
  "incident": {
    "notesRoot": "/Users/yusoof/incident-notes",
    "monitoringUrls": ["https://status.example/internal"]
  },
  "study": { "urls": ["https://course.example/lesson-1"] }
}
```

### Schema

- `workspaces`: object mapping workspace ids to settings. Ids match
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
  - `label`: nonempty string without control characters.
  - `app`: allowlisted macOS app id (below).
  - `paths`: array of validated local paths (rules below).
  - `urls`: array of validated URLs (rules below).
  - `agent` (optional): allowlisted agent name (below). Names only — the
    launcher maps each name to fixed arguments; config can never supply
    arguments.
- `attentionUrl`: one validated URL.
- `incident`: `notesRoot` (validated local path where timestamped notes
  folders are created) and `monitoringUrls` (validated URLs).
- `study`: `urls` (validated URLs).

**Unknown keys are rejected at every level** (top level, workspace, incident,
study). There is no `shell`, `command`, `shell_command`, `cmd`, `exec`,
`script` or `args` field anywhere, now or later; requesting one is rejected
explicitly. Pipico never runs shell commands from config. An unknown key is
echoed in the diagnostic through the control-free renderer (`echoSafe`): a
key whose JSON source escapes a newline, ESC, DEL or any other C0 control
appears with each control byte replaced by `?`, so the error stays one
readable line and injects no terminal control sequence.

### Allowlists

- App ids (`app`): `com.apple.Terminal`, `com.googlecode.iterm2`,
  `dev.warp.Warp-Stable`, `com.apple.Safari`, `com.google.Chrome`,
  `com.apple.finder`, `com.microsoft.VSCode`.
- Agent names (`agent`): `claude`, `codex`, `aider`.

Matching is exact and case-sensitive.

### Path rules

Configured paths (workspace `paths`, `incident.notesRoot`) must be:

- absolute (start with `/`; relative paths and unexpanded `~` are rejected);
- already normalized: **any `.` or `..` segment is rejected**, as are empty
  segments (`//`) and a trailing `/`. Non-normalized paths such as
  `/tmp/a/./b` are therefore rejected, not rewritten;
- free of control characters, including NUL, newline and escape.

Because every `..` segment is rejected outright, a configured path can never
traverse out of its root. Paths do not need to exist when the config is
validated.

### URL rules

Configured URLs (`attentionUrl`, workspace `urls`, `incident.monitoringUrls`,
`study.urls`) must:

- be `https:`, or `http:` **only** for localhost. "localhost" here means
  exactly the hosts `localhost`, `127.0.0.1` and `[::1]` (with any port);
  `http://localhost.evil.com/`, `http://127.0.0.1.nip.io/` and
  `http://10.0.0.1/` are rejected;
- never use any other scheme: `javascript:`, `file:`, `data:`, `vbscript:`,
  `ftp:` and `chrome:` are all rejected (anything not `https:`/`http:` is);
- have no embedded credentials (`user:password@host`) — and error messages
  never echo the URL;
- contain no whitespace or control characters.

## Execution rules (all handlers)

Every spawn goes through the one runner in `src/exec.ts`:

- argv arrays only; arguments reach the child verbatim. No shell is ever
  involved (no `shell` option is ever set), and the program path is always
  absolute.
- Every spawn has a mandatory finite timeout; the child is SIGKILLed at it:
  `open`-family calls 15 s, the osascript chooser 5 min (it waits for the
  user), an agent launch 6 h (pipico waits for the agent to exit).
- The child environment is built from an explicit allowlist (`HOME`, `LANG`,
  `LC_ALL`, `LOGNAME`, `PATH`, `TMPDIR`, `USER`), never inherited wholesale,
  so parent-only variables such as tokens or `PIPICO_*` test knobs never
  reach a child. pipico never enumerates environment variables.
- The child's stdin is ignored.
- A nonzero child exit is returned to the platform layer and becomes a
  single-line error; failures never spawn partial follow-ups.

Pipico never reads the clipboard or pasteboard, never reads shell history
and never enumerates environment variables.
Incident scaffolding is local only: no remote access, no remote commands, no
history or environment capture, no restarting, deploying or cleanup.

## Platform status (honest labels)

The macOS operations (`open -a`, `open <url>`, the osascript chooser, the
lock action, agent launch) are implemented in `src/platform/mac.ts` behind
the platform interface, with the argv shapes covered by tests through an
injected spawner. **No Mac is attached in this mission: every real macOS
execution is NOT_RUN** — including `doctor`'s macOS USB check
(`system_profiler`) and every real Shortcuts binding. On Linux the real
platform refuses every action with exit 4 and spawns nothing by design;
install/uninstall/doctor are host-independent and fully exercised here with
a temp `$HOME` and the fake platform.

## Binding F13–F16 in macOS Shortcuts

Shortcuts cannot be authored headlessly, so `pipico install` prints these
steps (with the absolute wrapper path it created, e.g.
`/Users/u/.local/bin/pipico`) instead of writing any binding:

1. Open the **Shortcuts** app on the Mac.
2. Create a new shortcut, add the action **Run Shell Script**, set the shell
   to `/bin/zsh` (or `/bin/sh`) and make sure "Run script" passes **no**
   input.
3. As the script body, use one line per key (all with the same absolute
   wrapper path):
   - F13 (single tap on the Pipico button) → `/Users/u/.local/bin/pipico action`
   - F14 (double tap) → `/Users/u/.local/bin/pipico attention`
   - F15 (hold for 1.5-3 s) → `/Users/u/.local/bin/pipico incident`
   - F16 (hold for 3-10 s) → `/Users/u/.local/bin/pipico lock`
4. Open the shortcut's detail panel → **Add Keyboard Shortcut** → press the
   corresponding F13–F16 key. (On laptops enable "Use F1, F2, etc. keys as
   standard function keys" or hold `fn`.)
5. Repeat for each of the four keys. Test with `pipico doctor` first; see
   `docs/pipico/HARDWARE-TESTS.md` for the board-side checklist.

The bindings are created manually, not by the CLI: `pipico install` creates
the per-user wrapper (above), prints these steps with absolute paths, and
never authors Shortcuts itself. It writes only under `$HOME`, records
everything it creates in
`$XDG_CONFIG_HOME|$HOME/.config/pipico/installed.json`, never overwrites
existing files, and `uninstall` removes only what is listed in that
manifest. No sudo, no cron, no launchd.

## Dependencies

`pipico` has **no runtime dependencies** (nothing in `dependencies`):
Bun built-ins plus TypeScript types only. Dev dependencies are test/type
tooling only: `typescript` and `@types/bun`.

## Known environment notes

- Bun's runtime converts `bun.lock` into `$HOME/.bun/install/cache/*.pile`
  the first time any project script runs with a fresh `$HOME`. That is Bun
  behavior, not pipico's (the CLI itself writes nothing; the test suite
  proves it with before/after HOME snapshots). When checking "HOME is
  unchanged", exclude `.bun` or run `bun src/cli.ts --help` once before the
  snapshot.
- Real macOS behavior (`open -a`, `open <url>`, the `osascript` chooser, the
  osascript lock keystroke) is implemented behind the platform layer and is
  NOT_RUN in this mission; on Linux the real platform refuses everything by
  design. The lock additionally needs one-time Automation and Accessibility
  grants for the host app (see "Lock permissions" above) — a checklist for
  verifying this on the real Mac lives in `docs/pipico/HARDWARE-TESTS.md`
  (written in the release milestone).
