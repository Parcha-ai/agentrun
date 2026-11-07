# The desktop the live Docker suite tests the X11 shim on: Debian with Xvfb and nothing else. computerd is mounted and
# runs as PID 1, as on any Docker computer; the provider starts Xvfb through it with process.start, so the X server is
# one process in its table and ends with the computer. The fixture app is written in by the cases themselves.
FROM debian:bookworm-slim
RUN apt-get update \
	&& apt-get install --yes --no-install-recommends xvfb \
	&& rm -rf /var/lib/apt/lists/*
