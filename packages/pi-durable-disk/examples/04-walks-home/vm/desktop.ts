// The VM's desktop: a virtual X display with a window manager, a VNC server behind noVNC so a person can watch the agent work in
// a browser, and the display the agent's computer tool (03-tab-to-cloud/computer-tool.ts) sees and drives. The image holds the
// programs (image.ts); this starts them in a booted VM, as the run user, each in its own session so the end of the exec that
// started them does not end them. The VNC password is a per-VM random value, uploaded to a root-only staging file and read by
// x11vnc from a file (never an argument); noVNC's page asks for it.
export const DESKTOP_DISPLAY = ":1";
export const DESKTOP_PORT = 6080;
export const SCREEN_GEOMETRY = "1280x720x24";
const LOG = "/var/tmp/pda-desktop.log";

/** A root script: `stage` holds vnc.txt (the password); it ends with noVNC answering on DESKTOP_PORT. */
export function desktopScript(stage: string): string {
  return String.raw`
set -eu
install -d -m 0750 -o root -g pda /etc/pda-demo
install -m 0400 -o pda -g pda ${stage}/vnc.txt /etc/pda-demo/vnc.txt
rm -f ${stage}/vnc.txt
install -o pda -g pda -m 0644 /dev/null ${LOG}
as_pda() { setsid -f sudo -n -u pda -H env DISPLAY=${DESKTOP_DISPLAY} "$@" >> ${LOG} 2>&1 < /dev/null; }
as_pda Xvfb ${DESKTOP_DISPLAY} -screen 0 ${SCREEN_GEOMETRY} -ac -nolisten tcp
for i in $(seq 1 100); do [ -S /tmp/.X11-unix/X${DESKTOP_DISPLAY.slice(1)} ] && break; sleep 0.1; done
[ -S /tmp/.X11-unix/X${DESKTOP_DISPLAY.slice(1)} ] || { echo "no X display"; tail -5 ${LOG}; exit 1; }
as_pda openbox
as_pda x11vnc -display ${DESKTOP_DISPLAY} -passwdfile /etc/pda-demo/vnc.txt -forever -shared -localhost -rfbport 5900 -noxdamage -quiet
for i in $(seq 1 100); do (echo > /dev/tcp/127.0.0.1/5900) 2>/dev/null && break; sleep 0.1; done
as_pda websockify --web /usr/share/novnc ${DESKTOP_PORT} 127.0.0.1:5900
for i in $(seq 1 100); do curl -fsS -o /dev/null http://127.0.0.1:${DESKTOP_PORT}/vnc.html 2>/dev/null && break; sleep 0.1; done
curl -fsS -o /dev/null http://127.0.0.1:${DESKTOP_PORT}/vnc.html || { echo "noVNC does not answer"; tail -5 ${LOG}; exit 1; }
echo desktop-ready
`;
}

/** The address a person opens to watch (and, with the password, drive) the desktop. `base` is the tunnel's https URL. */
export function novncUrl(base: string, password: string): string {
  return `${base.replace(/\/+$/, "")}/vnc.html?autoconnect=1&resize=scale&password=${encodeURIComponent(password)}`;
}

/** The screen as a JPEG, for a recording or a page that shows the desktop without VNC. */
export const SCREENSHOT_COMMAND = `sudo -n -u pda -H env DISPLAY=${DESKTOP_DISPLAY} import -window root -quality 70 jpeg:-`;
