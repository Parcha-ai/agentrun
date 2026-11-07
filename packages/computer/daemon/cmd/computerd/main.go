// computerd is the open platform's computer daemon: one static program in every computer.
//
//	computerd init --deadline <RFC 3339 time>
//	                    run as the computer's first process: hold every process and serve the protocol on a unix socket
//	                    (AGENTRUN_COMPUTERD_SOCKET, default /run/agentrun/computerd.sock) until SIGTERM or the deadline
//	computerd stdio     bridge stdin and stdout to init's socket (stdout carries protocol lines only; stderr is the log)
//	computerd version   print the version
//
// Each exec.run and process.start starts itself again as `computerd guard`, with no other caller (see execrun.Guard).
package main

import (
	"fmt"
	"log"
	"os"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/daemon"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
)

var version = "0.0.0-dev"

func main() {
	logger := log.New(os.Stderr, "computerd: ", log.LstdFlags)
	if len(os.Args) < 2 || (os.Args[1] != "init" && len(os.Args) != 2) {
		usage()
	}
	switch os.Args[1] {
	case "version":
		fmt.Println(version)
	case "stdio":
		os.Exit(daemon.Bridge(daemon.SocketPath(), os.Stdin, os.Stdout, os.Stderr))
	case "init":
		deadline, ok := deadlineOf(logger, os.Args[2:])
		if !ok {
			os.Exit(2)
		}
		os.Exit(daemon.Init(version, daemon.SocketPath(), deadline, logger))
	case execrun.GuardCommand:
		os.Exit(execrun.Guard())
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: computerd init --deadline <RFC 3339 time> | stdio | version")
	os.Exit(2)
}

// deadlineOf reads init's `--deadline <time>`. With none, or one that is not RFC 3339, it says why and init refuses to
// start, so no computer lives forever.
func deadlineOf(logger *log.Logger, args []string) (time.Time, bool) {
	if len(args) != 2 || args[0] != "--deadline" {
		logger.Printf("init: --deadline <time> is required, in RFC 3339 such as 2026-01-02T15:04:05Z: the computer ends then")
		return time.Time{}, false
	}
	deadline, err := time.Parse(time.RFC3339Nano, args[1])
	if err != nil {
		logger.Printf("init: --deadline %q is not a time in RFC 3339, such as 2026-01-02T15:04:05Z", args[1])
		return time.Time{}, false
	}
	return deadline, true
}
