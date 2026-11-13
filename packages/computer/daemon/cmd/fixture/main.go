// computerd-fixture is the desktop fixture of the conformance suite (src/conformance/fixture.ts), test-only and never
// shipped: a 200x200 window at (0, 0) in four colors that takes the focus and logs each input event as a JSON line.
//
//	computerd-fixture --log <path>
//
// It shows on $DISPLAY, or, when that is not set (process.start passes no DISPLAY), on the lowest-numbered display in
// /tmp/.X11-unix. It runs until it is signalled or the display goes.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/fixture"
)

func main() {
	if len(os.Args) != 3 || os.Args[1] != "--log" || os.Args[2] == "" {
		fmt.Fprintln(os.Stderr, "usage: computerd-fixture --log <path>")
		os.Exit(2)
	}
	display := os.Getenv("DISPLAY")
	if display == "" {
		display = lowestDisplay()
	}
	if display == "" {
		fmt.Fprintln(os.Stderr, "computerd-fixture: DISPLAY is not set and /tmp/.X11-unix has no display")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if err := fixture.Run(ctx, display, os.Args[2]); err != nil {
		fmt.Fprintf(os.Stderr, "computerd-fixture: %v\n", err)
		os.Exit(1)
	}
}

// lowestDisplay is ":<n>" for the lowest X<n> socket in /tmp/.X11-unix, or "".
func lowestDisplay() string {
	names, _ := filepath.Glob("/tmp/.X11-unix/X*")
	var numbers []int
	for _, name := range names {
		if n, err := strconv.Atoi(strings.TrimPrefix(filepath.Base(name), "X")); err == nil {
			numbers = append(numbers, n)
		}
	}
	if len(numbers) == 0 {
		return ""
	}
	sort.Ints(numbers)
	return ":" + strconv.Itoa(numbers[0])
}
