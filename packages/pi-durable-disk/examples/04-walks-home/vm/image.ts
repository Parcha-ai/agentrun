// The Modal image every VM of the demo starts from: Ubuntu with the pinned runtime the agent's host needs (Node, the archil
// client with FUSE, the run user, the app's dependencies). Modal builds it once and caches it by content, so a sandbox of it
// starts in a fraction of a second and the only per-box setup left is the app bundle (`prepareScript`, a few seconds).
// What the VM gains later (Docker, a desktop) is appended here as more commands, so the layers above stay cached.
import { gpuDockerfile } from "../../03-tab-to-cloud/pipe/daytona.ts";

/**
 * Dockerfile commands, in order. `uid` and `gid` are the demo server's, so files the agent writes belong to one user everywhere.
 * `archil: false` leaves out the archil client and FUSE (its package names are Ubuntu 24.04's): for a box that never mounts the
 * disk, such as a GPU sandbox on a Debian base that runs the agent through the pipe.
 */
export function vmImageCommands(uid: number, gid: number, options: { archil?: boolean; desktop?: boolean } = {}): string[] {
  const archil = options.archil ?? true;
  return [
    "RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends sudo curl ca-certificates xz-utils git procps iproute2 >/dev/null && rm -rf /var/lib/apt/lists/*",
    // The base image's own `ubuntu` user holds uid 1000, the server's: `id pda` would then answer "ubuntu" and sudo, which matches
    // the caller's name, would not find the run user's rule. The run user is the only unprivileged user here.
    "RUN userdel -r ubuntu 2>/dev/null || true; getent group ubuntu >/dev/null && groupdel ubuntu || true",
    // The runtime (Node, archil with libfuse2 and fuse3, the run user, the app's dependencies) is the GPU class's recipe for Daytona.
    ...gpuDockerfile(uid, gid).split("\n").filter((line) => line.startsWith("RUN ") && (archil || !line.includes("archil.deb"))),
    // The agent's commands run with the launcher's PATH, which has no /opt: node, npm and npx are on it so the agent can use them.
    "RUN ln -sf /opt/node24/bin/node /usr/local/bin/node && ln -sf /opt/node24/bin/npm /usr/local/bin/npm && ln -sf /opt/node24/bin/npx /usr/local/bin/npx",
    ...(options.desktop ? DESKTOP_COMMANDS : []),
  ];
}

/** The playwright release whose Chromium the desktop installs: pinned, so the browser is one build everywhere. */
export const PLAYWRIGHT_VERSION = "1.64.0";

/**
 * A desktop the agent can drive: a virtual X display, a light window manager, a VNC server behind noVNC for a person to watch,
 * xdotool and ImageMagick for the agent's computer tool, and a real Chromium (Playwright's build, since Ubuntu's is a snap).
 * Appended last, so the layers above stay cached.
 */
const DESKTOP_COMMANDS = [
  "RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends xvfb x11vnc novnc websockify xdotool imagemagick openbox xterm x11-utils dbus-x11 fonts-dejavu-core python3 >/dev/null && rm -rf /var/lib/apt/lists/*",
  `RUN PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright /opt/node24/bin/npx --yes playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium >/dev/null 2>&1 && chmod -R a+rX /opt/ms-playwright && rm -rf /var/lib/apt/lists/* /root/.npm && printf '#!/bin/sh\\nexec %s --no-sandbox --disable-dev-shm-usage --no-first-run --disable-gpu "$@"\\n' "$(find /opt/ms-playwright -name chrome -type f | head -1)" > /usr/local/bin/chromium && chmod 0755 /usr/local/bin/chromium && /usr/local/bin/chromium --version`,
];
