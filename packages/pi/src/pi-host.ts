// The Pi host this release supports: the exact version of its pi-durable and chord peers (the pi family moves together,
// one version). `/agentrun status` flags a host at any other version, without blocking it, and names that version as
// the one to install.
const SUPPORTED = [1, 5, 0] as const;

export const SUPPORTED_PI_RANGE = SUPPORTED.join(".");
export const NEWEST_TESTED_PI_VERSION = SUPPORTED_PI_RANGE;

/** Whether Pi `version` is the supported one. As npm reads an exact version, a prerelease is not; nor is a version that
 *  is not `x.y.z`. */
export function isSupportedPi(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version) && version === SUPPORTED_PI_RANGE;
}

/** The status line for Pi host `version`: the supported version, and for any other host the one to install. */
export function piHostLine(version: string): string {
  return isSupportedPi(version)
    ? `Pi host: ${version} (supported: ${SUPPORTED_PI_RANGE})`
    : `Pi host: ${version} (outside the supported range ${SUPPORTED_PI_RANGE}; the newest tested host: npm install -g @earendil-works/pi-coding-agent@${NEWEST_TESTED_PI_VERSION})`;
}
