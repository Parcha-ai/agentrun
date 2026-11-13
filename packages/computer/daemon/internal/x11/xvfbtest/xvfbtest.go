// Package xvfbtest starts an Xvfb for a test, on a display number it picks itself, and ends it with the test. A host
// without Xvfb skips the test in words: the fake X server tests and the Docker desktop suite still run there.
package xvfbtest

import (
	"bufio"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Start runs Xvfb with one screen of width x height at 24 bits and returns its DISPLAY, such as ":3".
func Start(t *testing.T, width, height int) string {
	t.Helper()
	path, err := exec.LookPath("Xvfb")
	if err != nil {
		t.Skip("Xvfb is not on PATH: the X server tests run against the fake X server, and the desktop image's Docker suite")
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	// -displayfd: Xvfb picks a free display and writes its number to fd 3 once it is ready for clients.
	cmd := exec.Command(path, "-displayfd", "3", "-screen", "0", strings.Join([]string{itoa(width), "x", itoa(height), "x24"}, ""), "-nolisten", "tcp")
	cmd.ExtraFiles = []*os.File{w}
	var log strings.Builder
	cmd.Stderr = &log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = w.Close()
	ended := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(ended)
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		<-ended
	})
	number := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(r).ReadString('\n')
		number <- strings.TrimSpace(line)
	}()
	select {
	case n := <-number:
		if n == "" {
			t.Fatalf("Xvfb gave no display number: %s", log.String())
		}
		return ":" + n
	case <-time.After(30 * time.Second):
		t.Fatalf("Xvfb was not ready within 30 s: %s", log.String())
	}
	return ""
}

func itoa(n int) string {
	var digits []byte
	if n == 0 {
		return "0"
	}
	for ; n > 0; n /= 10 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
	}
	return string(digits)
}
