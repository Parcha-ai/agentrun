import assert from 'node:assert/strict';

/** Mode of a regular executable packed as 0755 after npm 11 extracts it.
 * Pacote adds its file baseline (0666), applies npm's configured umask, and retains
 * owner read/write. The OS then applies the installing process's umask. These are
 * embedded files, not package.json bins (whose links have a separate chmod step).
 * The archive's exact 0755 requirement is checked separately before installation.
 */
export function npmExecutableMode(npmUmask, systemUmask) {
  for (const value of [npmUmask, systemUmask]) {
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 0o777, 'A file-creation mask must be an integer from 0 to 0777');
  }
  return (((0o755 | 0o666) & ~npmUmask) | 0o600) & ~systemUmask;
}
