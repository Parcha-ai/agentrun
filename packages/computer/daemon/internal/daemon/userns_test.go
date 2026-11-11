package daemon_test

import (
	"fmt"
	"log"
	"os"
	"strings"
	"syscall"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/daemon"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/isolate"
)

// The fallback's last step: where root may not make the network namespace (the refusal it is handed) and the user
// namespace cannot be made either (as any user but root, mapping every id to itself takes CAP_SETUID and CAP_SETGID),
// init refuses to start in words that name both ways, and exits 1: the computer fails closed. That it serves where the
// user namespace can be made is the Docker live test's (test/docker/modal-commands.docker.test.mjs), as root.
func TestInitInUserNamespaceRefusesInWordsNamingBothWays(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("runs as root: the child would start; the fallback that serves is the Docker live test's")
	}
	var logged strings.Builder
	refused := fmt.Errorf("%w: %w", isolate.ErrNoNetworkNamespace, syscall.EPERM)
	code := daemon.InitInUserNamespace(os.Args[0], []string{"--deadline", "2099-01-01T00:00:00Z", "--user", "2510:2510", "--own-network"}, refused, log.New(&logged, "", 0))
	words := logged.String()
	if code != 1 || !strings.Contains(words, "init refuses to start") || !strings.Contains(words, "CAP_SYS_ADMIN") || !strings.Contains(words, "nor can it start itself again in a user and a network namespace of its own") || !strings.Contains(words, "CAP_SETUID") {
		t.Fatalf("InitInUserNamespace as uid %d: exit %d, %q; want 1 and words naming the network namespace and the user namespace", os.Geteuid(), code, words)
	}
}
