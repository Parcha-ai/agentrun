// computerd is the open platform's computer daemon: one static program in every computer.
//
//	computerd stdio     serve the protocol on stdin and stdout (stdout carries protocol lines only; stderr is the log)
//	computerd init      run as the computer's first process: reap orphans until SIGTERM
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

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/methods"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

var version = "0.0.0-dev"

func main() {
	logger := log.New(os.Stderr, "computerd: ", log.LstdFlags)
	if len(os.Args) != 2 {
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
		initProcess(logger)
	case execrun.GuardCommand:
		os.Exit(execrun.Guard())
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: computerd stdio | init | version")
	os.Exit(2)
}

// initProcess holds the computer open as its first process. Orphans in the computer are handed to it, so it reaps
// them; SIGTERM or SIGINT (docker stop) ends it, and the computer with it.
func initProcess(logger *log.Logger) {
	signals := make(chan os.Signal, 8)
	signal.Notify(signals, syscall.SIGCHLD, syscall.SIGTERM, syscall.SIGINT)
	if os.Getpid() != 1 {
		logger.Printf("init: running as pid %d, not 1: only this process's own orphans are reaped", os.Getpid())
	}
	for sig := range signals {
		if sig != syscall.SIGCHLD {
			logger.Printf("init: %v, stopping", sig)
			return
		}
		reap()
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
