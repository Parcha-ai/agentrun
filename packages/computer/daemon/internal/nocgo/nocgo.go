// Package nocgo runs a package's tests in a test binary built without cgo, as computerd is built.
//
// Go builds with cgo wherever it finds a C compiler, so a plain `go test ./...` makes test binaries that link cgo. In
// one of those, syscall.AllThreadsSyscall cannot reach every thread and fails with ENOTSUP, so init refuses to start
// for that reason alone, and the refusal for a capability it cannot drop (EPERM), its deadline and the drop go
// untested. A package whose tests need the binary computerd is calls Run from its TestMain:
//
//	func TestMain(m *testing.M) { os.Exit(nocgo.Run(m)) }
//
// and each such test calls Require.
package nocgo

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
)

// ChildEnv marks the test binary Run starts, so one that links cgo all the same is not rebuilt again.
const ChildEnv = "AGENTRUN_NOCGO_CHILD"

// Run runs m's tests in a test binary without cgo and returns the exit code. In a binary built without cgo, or with
// -race (which needs cgo), it is m.Run(). In one with cgo it builds the same package's test binary again with
// CGO_ENABLED=0 go test -c (the package from go list, run where go test runs a test binary: the package's directory),
// runs it with the same arguments and environment and CGO_ENABLED=0, and returns its exit code. It never calls m.Run
// then: no test runs in the binary with cgo.
func Run(m *testing.M) int {
	if !Cgo || Race {
		return m.Run()
	}
	if os.Getenv(ChildEnv) != "" {
		fmt.Fprintln(os.Stderr, "nocgo: the test binary built with CGO_ENABLED=0 links cgo all the same; refusing to build it again")
		return 2
	}
	code, err := rerun(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "nocgo: %v\n", err)
		return 2
	}
	return code
}

// Require fails a test that runs in a test binary with cgo, and skips one in a -race build, which needs cgo: the plain
// go test runs it without cgo.
func Require(t testing.TB) {
	t.Helper()
	if !Cgo {
		return
	}
	if Race {
		t.Skip("-race needs cgo, and this test needs a binary without it, as computerd is built: go test without -race runs it")
	}
	t.Fatal("this test binary links cgo: its package's TestMain must return nocgo.Run(m)")
}

// goTool is the go command: under GOROOT as go test sets it, under the GOROOT this binary was built with, or on PATH.
func goTool() (string, error) {
	for _, root := range []string{os.Getenv("GOROOT"), runtime.GOROOT()} {
		if root == "" {
			continue
		}
		path := filepath.Join(root, "bin", "go")
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path, nil
		}
	}
	path, err := exec.LookPath("go")
	if err != nil {
		return "", fmt.Errorf("no go command under GOROOT or on PATH, to build this package's tests without cgo: %w", err)
	}
	return path, nil
}

// rerun builds the package in the working directory as a test binary without cgo, runs it with args, and returns its
// exit code.
func rerun(args []string) (int, error) {
	tool, err := goTool()
	if err != nil {
		return 0, err
	}
	env := append(os.Environ(), "CGO_ENABLED=0")
	list := exec.Command(tool, "list", "-f", "{{.ImportPath}}", ".")
	list.Env = env
	list.Stderr = os.Stderr
	listed, err := list.Output()
	if err != nil {
		return 0, fmt.Errorf("go list in %s: %w", workingDir(), err)
	}
	pkg := strings.TrimSpace(string(listed))
	dir, err := os.MkdirTemp("", "nocgo-")
	if err != nil {
		return 0, err
	}
	defer os.RemoveAll(dir)
	binary := filepath.Join(dir, filepath.Base(pkg)+".test")
	build := []string{"test", "-c", "-o", binary}
	if mode := testing.CoverMode(); mode != "" {
		build = append(build, "-covermode="+mode)
	}
	compile := exec.Command(tool, append(build, pkg)...)
	compile.Env = env
	compile.Stdout = os.Stderr
	compile.Stderr = os.Stderr
	if err := compile.Run(); err != nil {
		return 0, fmt.Errorf("CGO_ENABLED=0 go test -c %s: %w", pkg, err)
	}
	child := exec.Command(binary, args...)
	child.Env = append(env, ChildEnv+"=1")
	child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
	// The test binary without cgo ends with this one, should go test kill it. Pdeathsig follows the thread that started
	// the child, so this goroutine keeps its thread until the child has ended.
	child.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	runtime.LockOSThread()
	err = child.Run()
	runtime.UnlockOSThread()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		if code := exit.ExitCode(); code >= 0 {
			return code, nil
		}
		return 1, fmt.Errorf("the test binary without cgo ended by %v", exit)
	}
	if err != nil {
		return 0, fmt.Errorf("running the test binary without cgo: %w", err)
	}
	return 0, nil
}

func workingDir() string {
	dir, err := os.Getwd()
	if err != nil {
		return "the working directory"
	}
	return dir
}
