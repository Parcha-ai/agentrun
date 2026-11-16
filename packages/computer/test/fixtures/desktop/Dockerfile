# The desktop the live Docker suite tests the X11 shim on: Alpine with Xvfb and xterm, the stock app the apps cases
# launch and terminate (its desktop file is xterm.desktop), and nothing else (about 50 MB; Debian's xvfb pulls in Mesa
# and LLVM, 419 MB). computerd is mounted and runs as PID 1, as on any Docker computer; the provider starts Xvfb through
# it with process.start, so the X server is one process in its table and ends with the computer. The cases write the
# fixture app in themselves.
FROM alpine:3.20
RUN apk add --no-cache xvfb xterm && test -f /usr/share/applications/xterm.desktop
