package probe_test

import (
	"encoding/json"
	"net"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/probe"
)

// listening is an address a connection reaches: a port of this machine's own.
func listening(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	return listener.Addr().String()
}

// refusing is an address nothing listens on any more.
func refusing(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	return address
}

func TestRunReportsOnlyWhatItReachedInTheOrderAsked(t *testing.T) {
	open, closed := listening(t), refusing(t)
	other := listening(t)
	result := probe.Run([]string{closed, open, other}, 2*time.Second)
	if !reflect.DeepEqual(result.Reached, []string{open, other}) {
		t.Fatalf("reached %q; want %q, and never %s, where nothing listens", result.Reached, []string{open, other}, closed)
	}
}

func TestRunReportsItsOwnUserAndTheKernel(t *testing.T) {
	result := probe.Run(nil, time.Second)
	if result.UID != os.Getuid() || result.GID != os.Getgid() {
		t.Fatalf("uid:gid %d:%d; want this process's %d:%d", result.UID, result.GID, os.Getuid(), os.Getgid())
	}
	if strings.TrimSpace(result.Kernel) == "" {
		t.Fatal("no kernel release in the report")
	}
}

func TestRunWithNothingReachedIsAnEmptyListInJSON(t *testing.T) {
	encoded, err := json.Marshal(probe.Run([]string{refusing(t)}, time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"reached":[]`) {
		t.Fatalf("%s: reached must be [] when nothing was reached, never null", encoded)
	}
}
