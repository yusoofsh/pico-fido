# Reproducibility: two clean builds from fresh clones (NOT reproducible across build paths)

Status: **BUILT** (comparison observed this session, 2026-10-07).
**No reproducible-build claim is made.** The two builds below come from
two independent fresh recursive clones of the pushed branch at the same
SHAs, built with the documented single command in two different
directories. Their hashes differ; the cause is diagnosed below.

## The comparison

Clone command (run in `/home/factory-user/work/build-scratch/`):

```
git clone --recurse-submodules -b pipico/integration-v1 https://github.com/yusoofsh/pico-fido rb1
git clone --recurse-submodules -b pipico/integration-v1 https://github.com/yusoofsh/pico-fido rb2
```

Both clones: root `b31a8ab969536d754a7737c3ffe12bf7c6e3da5f`, submodule
`654fbda1046c0dba3832ff520f7d1ea25d1df45b` == gitlink,
`git submodule status --recursive` clean (no `-`/`+`/`U`),
`git status --porcelain` empty in root and submodule.

Build command in each clone (env: the mission's pinned
PICO_SDK_PATH/PICOTOOL_DIR/toolchain):

```
scripts/pipico/build.sh
```

Both builds exited 0 with zero CMake/compiler diagnostics and passed the
clock, image-bounds and companion-budget gates (the budget gate built a
fresh `PIPICO_COMPANION=OFF` baseline inside each clone).

SHA-256 of the build outputs:

| File | rb1 (`build-scratch/rb1/build-pipico`) | rb2 (`build-scratch/rb2/build-pipico`) |
|---|---|---|
| `pico_fido.uf2` | `90ce93fe19d1a9b3b2a9323f84853dd999e48fe627d7df50b6ab4709dc1b0578` | `af3e4b5112463a211ce2d26bbaa24f6b090bbecae156bbd30b8adfc4d52bbcf8` |
| `pico_fido.bin` | `64345cce1eeb3c5fb996cd315a37387865add6f57253020a31294071fdfe52f7` | `2b07cad88da7083f85b0e8bb63432c645480dce2c941b7a0fc64c692383fe7f0` |
| `pico_fido.elf` | `1f712c4f387d724a8e3acbacfbbdd15a31845f04ad8537d325d9a5094ac2bfbb` | `81d38b981f871715837d086bc88c6fe371ee176e5daa765a9f6ee5299884c1a3` |

**Outcome: the hashes differ.** The CI artifact of the same source SHA
(run `37685884106`, runner path `/home/runner/work/pico-fido/pico-fido`)
prints a third hash set (`RELEASE-MANIFEST.md` section 4).

## Diagnosed cause: absolute source paths embedded in the image

The UF2 payloads differ in exactly **11 bytes**, every one of them a
single character `1` vs `2` (the only character that differs between the
two build paths). `cmp -l` offsets (1-based): 432957, 434901, 440653,
447689, 448477 and 6 more. Reading around the offsets shows the context:

```
home/factory-user/work/build-scratch/rb1/src/fido/cbor.c            (rb1) / rb2 (rb2)
home/factory-user/work/build-scratch/rb1/src/fido/cbor_get_info.c
home/factory-user/work/build-scratch/rb1/src/fido/cbor_make_credential.c
home/factory-user/work/build-scratch/rb1/src/fido/cbor_client_pin.c
home/factory-user/work/build-scratch/rb1/src/fido/credential.c
```

These are `__FILE__`-style source-path strings next to error-diagnostic
format strings (for example `"Cannot encode CBOR [%…"`): the firmware's
CBOR error paths embed the absolute path of each source file, taken from
the compiler's invocation (the build configures with absolute
`-S`/`-B` paths). Because rb1 and rb2 differ only in one character of
the path, the section sizes stay identical (`.text=430356`,
`.rodata=107780` in both) and only the path character changes. The CI
runner path has a different *length*, so there the string constants
change size too (`.text=430348`, `.rodata=107740`), which is why the CI
hash set differs further and why the budget flash delta moves from 1200 B
to 1192 B (`budget-fresh-clone.txt`).

The ELF additionally carries debug info with the same absolute paths
(its hash differs the same way).

## Consequences

- No file in `docs/pipico/`, the root `README.md` or the draft PR claims
  a reproducible build.
- A build from a fixed path is stable for identical build inputs,
  observed directly: the CI artifacts of runs `37682443999` (source
  `5833bc2`, 7 docs-only commits earlier) and `37685884106` (source
  `b31a8ab`) carry byte-identical `pico_fido.uf2` (`cfbaa430…`),
  `pico_fido.elf` (`5e872a1c…`) and `pico_fido.bin` (`ce8b8be4…`) —
  both runs build at the same fixed runner path, and docs-only commits
  change no build input. Rerunning the bounds gate on the released
  binaries reprints the same numbers (`image-bounds-report.json`).
- A future fix (compiling with `-ffile-prefix-map` or relative source
  paths) is possible but was not in scope for this feature; the honest
  state is recorded instead.
