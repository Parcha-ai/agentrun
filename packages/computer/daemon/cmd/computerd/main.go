// computerd is the open platform's computer daemon: one static program in every computer.
//
//	computerd stdio     serve the protocol on stdin and stdout
//	computerd init      run as the computer's first process: reap orphans until SIGTERM
//	computerd version   print the version
package main

import (
	"fmt"
	"os"
)

var version = "0.0.0-dev"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "version" {
		fmt.Println(version)
		return
	}
	fmt.Fprintln(os.Stderr, "computerd: not implemented")
	os.Exit(2)
}
