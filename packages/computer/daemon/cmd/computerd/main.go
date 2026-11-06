// computerd is the open platform's computer daemon: one static program in every computer.
//
//	computerd init      run as the computer's first process: hold every process and serve the protocol on a unix socket
//	                    (AGENTRUN_COMPUTERD_SOCKET, default /run/agentrun/computerd.sock) until SIGTERM
//	computerd stdio     bridge stdin and stdout to init's socket (stdout carries protocol lines only; stderr is the log)
//	computerd version   print the version
//
// Each exec.run and process.start starts itself again as `computerd guard`, with no other caller (see execrun.Guard).
package main

import (
	"fmt"
	"log"
	"os"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/daemon"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
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
		os.Exit(daemon.Bridge(daemon.SocketPath(), os.Stdin, os.Stdout, os.Stderr))
	case "init":
		os.Exit(daemon.Init(version, daemon.SocketPath(), logger))
	case execrun.GuardCommand:
		os.Exit(execrun.Guard())
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: computerd init | stdio | version")
	os.Exit(2)
}
