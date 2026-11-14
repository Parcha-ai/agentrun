# The desktop E2B and Agent37 run, for the window manager's isolation test (test/docker/desktop-xfwm4.docker.test.mjs):
# Debian trixie, the Agent37 box's base, with Xvfb, xfwm4 and Mousepad, plus what E2B Desktop has around them. dbus-x11
# lets an app with no session bus start one of its own. at-spi2-core and gnome-keyring are what such a bus starts:
# an accessibility bus under the user's home, and a keyring socket. There is no passwd entry for 2510, as on E2B
# Desktop: init names the user. /work is its home.
FROM debian:trixie-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		xvfb xfwm4 mousepad dbus dbus-x11 at-spi2-core gnome-keyring \
	&& rm -rf /var/lib/apt/lists/* \
	&& test -f /usr/share/applications/org.xfce.mousepad.desktop \
	&& mkdir -m 0755 /work && chown 2510:2510 /work
