package nocgo_test

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/nocgo"
)

func TestMain(m *testing.M) { os.Exit(nocgo.Run(m)) }

// reportEnv makes TestChildReport write what its test binary is to this file; failEnv makes it fail too.
const (
	reportEnv = "NOCGO_TEST_REPORT"
	failEnv   = "NOCGO_TEST_FAIL"
)

// The build the test below makes sets these, by the nocgo_probe tag (probe_tag_test.go) and by -ldflags -X, so the
// child can say whether its own build carried them.
var (
	taggedProbe bool
	ldflagProbe = "unset"
)

const ldflagVar = "github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/nocgo_test.ldflagProbe"

func TestThisTestRunsWithoutCgo(t *testing.T) {
	nocgo.Require(t)
	if nocgo.Cgo {
		t.Fatal("Require let a test run in a binary that links cgo")
	}
}

// TestChildReport is run only by the test below, in the binary Run builds.
func TestChildReport(t *testing.T) {
	report := os.Getenv(reportEnv)
	if report == "" {
		t.Skip("run by TestRunRebuildsATestBinaryWithCgoWithoutIt, in the binary nocgo.Run builds")
	}
	line := fmt.Sprintf("cgo=%t child=%s CGO_ENABLED=%s tag=%t ldflag=%s args=%s\n", nocgo.Cgo, os.Getenv(nocgo.ChildEnv), os.Getenv("CGO_ENABLED"), taggedProbe, ldflagProbe, strings.Join(os.Args[1:], " "))
	if err := os.WriteFile(report, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	if os.Getenv(failEnv) != "" {
		t.Error("failing, as asked")
	}
}

// A test binary of this package built with cgo runs its tests in one without, built with the same -tags and -ldflags,
// with its arguments and environment, and exits with that one's code.
func TestRunRebuildsATestBinaryWithCgoWithoutIt(t *testing.T) {
	nocgo.Require(t)
	tool, err := exec.LookPath("go")
	if err != nil {
		t.Skip("no go command on PATH to build a test binary with cgo")
	}
	cc, _ := exec.Command(tool, "env", "CC").Output()
	if _, err := exec.LookPath(strings.TrimSpace(string(cc))); err != nil {
		t.Skipf("no C compiler (%q), so no test binary with cgo to rebuild", strings.TrimSpace(string(cc)))
	}
	dir := t.TempDir()
	withCgo := filepath.Join(dir, "with-cgo.test")
	build := exec.Command(tool, "test", "-c", "-o", withCgo, "-tags", "nocgo_probe", "-ldflags", "-X "+ldflagVar+"=carried", ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=1")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("CGO_ENABLED=1 go test -c: %v: %s", err, out)
	}
	run := func(fail bool) (int, string, string) {
		report := filepath.Join(dir, fmt.Sprintf("report-%t", fail))
		cmd := exec.Command(withCgo, "-test.run=^TestChildReport$", "-test.v")
		cmd.Env = append(os.Environ(), reportEnv+"="+report)
		// The binary with cgo is started as go test starts one: not as a child of Run, and with cgo as Go's default.
		cmd.Env = append(cmd.Env, nocgo.ChildEnv+"=", "CGO_ENABLED=1")
		if fail {
			cmd.Env = append(cmd.Env, failEnv+"=1")
		}
		var out bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &out
		err := cmd.Run()
		code := 0
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		} else if err != nil {
			t.Fatal(err)
		}
		line, _ := os.ReadFile(report)
		return code, string(line), out.String()
	}
	code, line, out := run(false)
	if code != 0 || !strings.HasPrefix(line, "cgo=false child=1 CGO_ENABLED=0 tag=true ldflag=carried args=-test.run=^TestChildReport$ -test.v") {
		t.Fatalf("passing: exit %d, report %q; want exit 0 from a binary without cgo, built with the same -tags and -ldflags and given the same arguments; output:\n%s", code, line, out)
	}
	if !strings.Contains(out, "--- PASS: TestChildReport") {
		t.Errorf("the child's output did not come through: %s", out)
	}
	code, line, out = run(true)
	if code != 1 || !strings.HasPrefix(line, "cgo=false") {
		t.Fatalf("failing: exit %d, report %q; want the child's exit 1 passed through; output:\n%s", code, line, out)
	}
}
