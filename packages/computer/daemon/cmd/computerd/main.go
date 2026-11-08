// computerd is the open platform's computer daemon: one static program in every computer.
//
//	computerd init --deadline <RFC 3339 time> [--max-deadline <RFC 3339 time>]
//	                    run as the computer's first process: hold every process and serve the protocol on a unix socket
//	                    (AGENTRUN_COMPUTERD_SOCKET, default /run/agentrun/computerd.sock) until SIGTERM or the deadline;
//	                    deadline.extend moves the deadline up to --max-deadline, and not at all without it. With DISPLAY
//	                    set, the screen and input methods drive that X display.
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
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/lifetime"
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
	fmt.Fprintln(os.Stderr, "usage: computerd init --deadline <RFC 3339 time> [--max-deadline <RFC 3339 time>] | stdio | version")
	os.Exit(2)
}

// deadlineOf reads init's `--deadline <time>` and the optional `--max-deadline <time>`, the most deadline.extend may
// move it to. With no deadline, or a time that is not RFC 3339, or a maximum before the deadline, it says why and init
// refuses to start, so no computer lives forever or past what its provider allows.
func deadlineOf(logger *log.Logger, args []string) (*lifetime.Deadline, bool) {
	const form = "init: --deadline <time> is required, and --max-deadline <time> may follow, in RFC 3339 such as 2026-01-02T15:04:05Z: the computer ends at the deadline, which deadline.extend moves up to the maximum"
	if (len(args) != 2 && len(args) != 4) || args[0] != "--deadline" || (len(args) == 4 && args[2] != "--max-deadline") {
		logger.Print(form)
		return nil, false
	}
	deadline, err := time.Parse(time.RFC3339Nano, args[1])
	if err != nil {
		logger.Printf("init: --deadline %q is not a time in RFC 3339, such as 2026-01-02T15:04:05Z", args[1])
		return nil, false
	}
	var most time.Time
	if len(args) == 4 {
		if most, err = time.Parse(time.RFC3339Nano, args[3]); err != nil {
			logger.Printf("init: --max-deadline %q is not a time in RFC 3339, such as 2026-01-02T15:04:05Z", args[3])
			return nil, false
		}
		if most.Before(deadline) {
			logger.Printf("init: --max-deadline %s is before --deadline %s", args[3], args[1])
			return nil, false
		}
	}
	return lifetime.New(deadline, most), true
}
