// Package daemon is computerd's two long-lived roles: init, the computer's first process, which holds every process and
// serves each connection on a unix socket; and stdio, a thin bridge from stdin and stdout to that socket.
package daemon

import (
	"fmt"
	"io"
	"log"
	"os"
)

// SocketEnv names the socket's path when it is not DefaultSocket.
const SocketEnv = "AGENTRUN_COMPUTERD_SOCKET"

// DefaultSocket is where init listens, in a directory only the daemon's user may enter.
const DefaultSocket = "/run/agentrun/computerd.sock"

// SocketPath is SocketEnv's value, or DefaultSocket.
func SocketPath() string {
	if path := os.Getenv(SocketEnv); path != "" {
		return path
	}
	return DefaultSocket
}

// Init serves the protocol on socket until SIGTERM or SIGINT, and returns the exit code.
func Init(version, socket string, logger *log.Logger) int {
	logger.Printf("init: not built yet")
	return 1
}

// Bridge copies in to the daemon at socket and its replies to out, and returns the exit code.
func Bridge(socket string, in io.Reader, out io.Writer, errOut io.Writer) int {
	fmt.Fprintln(errOut, "computerd stdio: the bridge is not built yet")
	return 1
}
