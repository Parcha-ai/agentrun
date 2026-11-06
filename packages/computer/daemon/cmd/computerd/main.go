// computerd is the open platform's computer daemon: one static program in every computer.
//
//	computerd stdio     serve the protocol on stdin and stdout (stdout carries protocol lines only; stderr is the log)
//	computerd init --deadline <RFC 3339 time>
//	                    run as the computer's first process: reap orphans until SIGTERM or the deadline
//	computerd version   print the version
//
// exec.run starts itself again as `computerd guard`, one per run, with no other caller (see execrun.Guard).
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/methods"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
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
		server := rpc.NewServer(methods.Handlers(version), logger)
		if err := server.Serve(context.Background(), os.Stdin, os.Stdout); err != nil {
			logger.Fatalf("stdio: %v", err)
		}
	case "init":
		os.Exit(initProcess(logger, os.Args[2:]))
	case execrun.GuardCommand:
		os.Exit(execrun.Guard())
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: computerd stdio | init --deadline <RFC 3339 time> | version")
	os.Exit(2)
}

// deadlineGrace is how long the computer's processes have between SIGTERM at the deadline and the end of PID 1.
const deadlineGrace = 2 * time.Second

// initProcess holds the computer open as its first process. Orphans in the computer are handed to it, so it reaps
// them; SIGTERM or SIGINT (docker stop) ends it, and the computer with it, and so does its deadline. With no deadline
// it refuses to start, so no computer lives forever.
func initProcess(logger *log.Logger, args []string) int {
	if len(args) != 2 || args[0] != "--deadline" {
		logger.Printf("init: --deadline <time> is required, in RFC 3339 such as 2026-01-02T15:04:05Z: the computer ends then")
		return 2
	}
	deadline, err := time.Parse(time.RFC3339Nano, args[1])
	if err != nil {
		logger.Printf("init: --deadline %q is not a time in RFC 3339, such as 2026-01-02T15:04:05Z", args[1])
		return 2
	}
	signals := make(chan os.Signal, 8)
	signal.Notify(signals, syscall.SIGCHLD, syscall.SIGTERM, syscall.SIGINT)
	if os.Getpid() != 1 {
		logger.Printf("init: running as pid %d, not 1: only this process's own orphans are reaped", os.Getpid())
	}
	timer := time.NewTimer(time.Until(deadline))
	for {
		select {
		case sig := <-signals:
			if sig != syscall.SIGCHLD {
				logger.Printf("init: %v, stopping", sig)
				return 0
			}
			reap()
		case <-timer.C:
			logger.Printf("init: the deadline %s has come, ending the computer", args[1])
			endAll()
			return 0
		}
	}
}

// endAll, as PID 1, sends SIGTERM to every other process in the computer and reaps for a short grace, until none is
// left; when PID 1 exits the kernel kills the rest. As any other pid it signals nothing: init starts no process.
func endAll() {
	if os.Getpid() != 1 {
		return
	}
	_ = syscall.Kill(-1, syscall.SIGTERM)
	for end := time.Now().Add(deadlineGrace); time.Now().Before(end) && syscall.Kill(-1, 0) == nil; {
		reap()
		time.Sleep(50 * time.Millisecond)
	}
}

func reap() {
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if pid <= 0 || err != nil {
			return
		}
	}
}
