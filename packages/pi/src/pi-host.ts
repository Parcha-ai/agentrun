// The Pi hosts this release supports: the range of its pi-durable and chord peers. `/agentrun status` flags a host
// outside it, without blocking it, and names the newest version CI runs (the `pi-1-2` job) as the one to install.
const FLOOR = [1, 0, 4] as const;
const CEILING = [1, 4, 0] as const;

export const SUPPORTED_PI_RANGE = `>=${FLOOR.join(".")} <${CEILING.join(".")}`;
export const NEWEST_TESTED_PI_VERSION = "1.3.0";

const compare = (a: readonly number[], b: readonly number[]): number =>
  (a[0]! - b[0]!) || (a[1]! - b[1]!) || (a[2]! - b[2]!);

/** Whether Pi `version` is in the supported range. As npm reads the range, a prerelease is not; nor is a version that
 *  is not `x.y.z`. */
export function isSupportedPi(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const parsed = match.slice(1).map(Number);
  return compare(parsed, FLOOR) >= 0 && compare(parsed, CEILING) < 0;
}

/** The status line for Pi host `version`: the supported range, and for a host outside it the newest tested one. */
export function piHostLine(version: string): string {
  return isSupportedPi(version)
    ? `Pi host: ${version} (supported: ${SUPPORTED_PI_RANGE})`
    : `Pi host: ${version} (outside the supported range ${SUPPORTED_PI_RANGE}; the newest tested host: npm install -g @earendil-works/pi-coding-agent@${NEWEST_TESTED_PI_VERSION})`;
}
