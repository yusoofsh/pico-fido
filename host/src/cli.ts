/**
 * pipico — host companion CLI for the Yusoofs Pipico FIDO key.
 *
 * This is the scaffold entry point; the command dispatcher lands in the
 * implementation commits (config validation, platform layer, handlers).
 */
export async function runCli(): Promise<{ code: number; stdout: string; stderr: string }> {
  return {
    code: 2,
    stdout: '',
    stderr: 'pipico: not wired up yet (scaffold)\n',
  };
}

if (import.meta.main) {
  const result = await runCli();
  if (result.stdout) await Bun.write(Bun.stdout, result.stdout);
  if (result.stderr) await Bun.write(Bun.stderr, result.stderr);
  process.exit(result.code);
}
