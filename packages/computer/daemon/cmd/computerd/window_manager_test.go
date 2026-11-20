package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/daemon"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/nocgo"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11/xvfbtest"
)

// windowManagerHere skips unless init can start a window manager here: Xvfb, xfwm4, dbus-run-session and xsetroot on
// PATH (the box image's desktop step), and init root with CAP_SYS_ADMIN to make the manager's network namespace. As
// another user, init runs as root of a user namespace of its own (unshare -Ur), as test/dial-desktop-xvfb.test.mjs runs
// it, and the manager as init's own uid: unshare -Ur maps that uid alone, and denies setgroups, which --user needs.
func windowManagerHere(t *testing.T) []string {
	t.Helper()
	nocgo.Require(t)
	for _, program := range []string{"Xvfb", "xfwm4", "dbus-run-session", "xsetroot"} {
		if _, err := exec.LookPath(program); err != nil {
			t.Skipf("%s is not on PATH: init's window manager runs where the desktop's programs are (the box image has them)", program)
		}
	}
	if os.Geteuid() == 0 {
		return nil
	}
	if exec.Command("unshare", "-Ur", "unshare", "-n", "true").Run() != nil {
		t.Skip("this host refuses a user namespace with its capabilities (unshare -Ur): init's window manager needs root that may make a network namespace")
	}
	return []string{"unshare", "-Ur"}
}

// freeDisplay is a display no X server here holds, from :300: for the one test whose init starts before its X server,
// so it must name the display first.
func freeDisplay(t *testing.T) string {
	t.Helper()
	for n := 300; n < 400; n++ {
		if _, err := os.Stat(fmt.Sprintf("/tmp/.X11-unix/X%d", n)); err != nil {
			if _, err := os.Stat(fmt.Sprintf("/tmp/.X%d-lock", n)); err != nil {
				return fmt.Sprintf(":%d", n)
			}
		}
	}
	t.Fatal("no free X display from :300 to :399")
	return ""
}

// startXvfb runs Xvfb on display until the test ends, and waits until it takes connections.
func startXvfb(t *testing.T, display string) {
	t.Helper()
	xvfb := exec.Command("Xvfb", display, "-screen", "0", "640x480x24", "-nolisten", "tcp")
	if err := xvfb.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = xvfb.Process.Kill(); _ = xvfb.Wait() })
	for until := time.Now().Add(30 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if conn, err := x11.Dial(display); err == nil {
			conn.Close()
			return
		}
		if time.Now().After(until) {
			t.Fatalf("Xvfb on %s took no connection within 30 s", display)
		}
	}
}

// initOn runs `computerd init` with DISPLAY display and args after its deadline, under wrap (unshare -Ur, or nothing as
// root), until the test ends, and returns its pid and socket once it listens.
func initOn(t *testing.T, wrap []string, display string, args ...string) (int, string) {
	t.Helper()
	return initWithPath(t, wrap, os.Getenv("PATH"), display, args...)
}

// initWithPath is initOn with init's PATH, which its programs and the window manager's start get.
func initWithPath(t *testing.T, wrap []string, path, display string, args ...string) (int, string) {
	t.Helper()
	dir, err := os.MkdirTemp("", "computerd-wm-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	socket := filepath.Join(dir, "computerd.sock")
	encoded, _ := json.Marshal(append([]string{"computerd", "init", "--deadline", time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, args...))
	argv := append(slices.Clone(wrap), os.Args[0])
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = []string{"PATH=" + path, "HOME=" + dir, argsEnv + "=" + string(encoded), daemon.SocketEnv + "=" + socket, "DISPLAY=" + display}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	ended := make(chan struct{})
	go func() { _ = cmd.Wait(); close(ended) }()
	t.Cleanup(func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-ended:
		case <-time.After(30 * time.Second):
			_ = cmd.Process.Kill()
			<-ended
		}
	})
	for until := time.Now().Add(30 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if conn, err := net.Dial("unix", socket); err == nil {
			conn.Close()
			return cmd.Process.Pid, socket
		}
		select {
		case <-ended:
			t.Fatalf("init ended before it listened: %s", stderr.String())
		default:
		}
		if time.Now().After(until) {
			t.Fatalf("init did not listen on %s within 30 s: %s", socket, stderr.String())
		}
	}
}

// helloOf is init's hello, whole.
func helloOf(t *testing.T, socket string) map[string]json.RawMessage {
	t.Helper()
	conn, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	if _, err := conn.Write([]byte(`{"jsonrpc":"2.0","id":1,"method":"hello","params":{"client":"test"}}` + "\n")); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var reply struct {
		Result map[string]json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(line, &reply); err != nil || reply.Result == nil {
		t.Fatalf("hello: %q (%v)", line, err)
	}
	return reply.Result
}

type windowManagerFact struct {
	State string `json:"state"`
	Why   string `json:"why"`
}

// factOf is hello's windowManager, and whether it is there.
func factOf(t *testing.T, hello map[string]json.RawMessage) (windowManagerFact, bool) {
	t.Helper()
	raw, ok := hello["windowManager"]
	if !ok {
		return windowManagerFact{}, false
	}
	var fact windowManagerFact
	if err := json.Unmarshal(raw, &fact); err != nil {
		t.Fatalf("hello's windowManager %s: %v", raw, err)
	}
	return fact, true
}

// managersOn is every xfwm4 whose DISPLAY is display, by pid.
func managersOn(display string) []int {
	entries, _ := os.ReadDir("/proc")
	found := []int{}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		comm, _ := os.ReadFile(filepath.Join("/proc", entry.Name(), "comm"))
		environ, _ := os.ReadFile(filepath.Join("/proc", entry.Name(), "environ"))
		if strings.TrimSpace(string(comm)) == "xfwm4" && slices.Contains(strings.Split(string(environ), "\x00"), "DISPLAY="+display) {
			found = append(found, pid)
		}
	}
	return found
}

// framed says whether a window manager has taken display: the root's _NET_SUPPORTING_WM_CHECK names a window, as
// internal/apps/windows.go reads it.
func framed(t *testing.T, display string) bool {
	t.Helper()
	conn, err := x11.Dial(display)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	check, err := conn.InternAtom("_NET_SUPPORTING_WM_CHECK", false)
	if err != nil {
		t.Fatal(err)
	}
	p, err := conn.GetProperty(conn.Screen().Root, check)
	return err == nil && len(p.Cardinals()) > 0 && p.Cardinals()[0] != 0
}

// statusOf is the first word of field (Uid, CapEff, ...) in process pid's status.
func statusOf(t *testing.T, pid int, field string) string {
	t.Helper()
	status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		t.Fatal(err)
	}
	for line := range strings.Lines(string(status)) {
		if value, ok := strings.CutPrefix(line, field+":"); ok {
			return strings.Fields(value)[0]
		}
	}
	t.Fatalf("process %d's status has no %s line", pid, field)
	return ""
}

func networkOf(t *testing.T, pid string) string {
	t.Helper()
	link, err := os.Readlink(filepath.Join("/proc", pid, "ns", "net"))
	if err != nil {
		t.Fatal(err)
	}
	return link
}

// Asked (--window-manager), init says the manager is starting while no display answers; once the X server comes up, it
// starts xfwm4 as the uid its programs run as, in a network namespace neither the host's nor its own, says it runs, and
// the manager frames the display. Its end ends the manager with it.
func TestInitAskedStartsTheWindowManagerOnceTheDisplayAnswers(t *testing.T) {
	wrap := windowManagerHere(t)
	display := freeDisplay(t)
	pid, socket := initOn(t, wrap, display, "--window-manager")
	hello := helloOf(t, socket)
	if fact, ok := factOf(t, hello); !ok || fact.State != "starting" {
		t.Fatalf("before the display answers, hello's windowManager is %s; want state starting", hello["windowManager"])
	}
	startXvfb(t, display)
	var fact windowManagerFact
	for until := time.Now().Add(30 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		fact, _ = factOf(t, helloOf(t, socket))
		if fact.State != "starting" || time.Now().After(until) {
			break
		}
	}
	if fact.State != "running" {
		t.Fatalf("hello's windowManager once the display answered: %+v; want running", fact)
	}
	managers := managersOn(display)
	if len(managers) != 1 {
		t.Fatalf("xfwm4 on %s: %v; want one", display, managers)
	}
	if uid := statusOf(t, managers[0], "Uid"); uid != strconv.Itoa(os.Getuid()) {
		t.Errorf("xfwm4 runs as uid %s; want %d, the uid init's programs run as", uid, os.Getuid())
	}
	for _, set := range []string{"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs"} {
		want := "0000000000000000"
		if set == "NoNewPrivs" {
			want = "1"
		}
		if got := statusOf(t, managers[0], set); got != want {
			t.Errorf("xfwm4's %s is %s; want %s", set, got, want)
		}
	}
	if mode := statusOf(t, managers[0], "Seccomp"); mode != "2" {
		t.Errorf("xfwm4's Seccomp is %s; want 2, the filter that refuses vsock and io_uring", mode)
	}
	own := networkOf(t, strconv.Itoa(managers[0]))
	if own == networkOf(t, "self") || own == networkOf(t, strconv.Itoa(pid)) {
		t.Errorf("xfwm4's network namespace is %s, the host's (%s) or init's (%s); want one of its own", own, networkOf(t, "self"), networkOf(t, strconv.Itoa(pid)))
	}
	for until := time.Now().Add(15 * time.Second); !framed(t, display); time.Sleep(50 * time.Millisecond) {
		if time.Now().After(until) {
			t.Fatal("no window manager took the display within 15 s: the root window has no _NET_SUPPORTING_WM_CHECK")
		}
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	for until := time.Now().Add(30 * time.Second); len(managersOn(display)) > 0; time.Sleep(50 * time.Millisecond) {
		if time.Now().After(until) {
			t.Fatalf("xfwm4 %v outlived init", managersOn(display))
		}
	}
}

// A manager that ends within its first second (here an xfwm4 that cannot take the display) is said in words, with how it
// ended and its last lines, for the client to fail create in them.
func TestInitSaysInWordsHowTheWindowManagerEndedWithinItsFirstSecond(t *testing.T) {
	wrap := windowManagerHere(t)
	display := xvfbtest.Start(t, 640, 480)
	bin := t.TempDir()
	fake := "#!/bin/sh\necho 'xfwm4: another window manager is running on this display' >&2\nexit 1\n"
	if err := os.WriteFile(filepath.Join(bin, "xfwm4"), []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	_, socket := initWithPath(t, wrap, bin+":"+os.Getenv("PATH"), display, "--window-manager")
	var fact windowManagerFact
	for until := time.Now().Add(30 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		fact, _ = factOf(t, helloOf(t, socket))
		if fact.State != "starting" || time.Now().After(until) {
			break
		}
	}
	if fact.State != "ended" || !strings.Contains(fact.Why, "exit code 1 within 1 s of starting on "+display) || !strings.Contains(fact.Why, "another window manager is running") {
		t.Fatalf("hello's windowManager after a manager that ends at once: %+v; want ended, with its exit code, when, and its last line", fact)
	}
}

// Not asked, init has no manager and hello says nothing of one, from its first hello: with no flag there is nothing to
// start, so the field's absence is decided before init listens.
func TestInitNotAskedStartsNoWindowManager(t *testing.T) {
	wrap := windowManagerHere(t)
	display := xvfbtest.Start(t, 640, 480)
	_, socket := initOn(t, wrap, display)
	hello := helloOf(t, socket)
	if _, ok := hello["windowManager"]; ok {
		t.Errorf("hello says windowManager %s; init was not asked for one", hello["windowManager"])
	}
	if !strings.Contains(string(hello["groups"]), `"screen"`) {
		t.Errorf("hello's groups %s; want the display's", hello["groups"])
	}
}

// --window-manager takes no value, once, and a display to run on: DISPLAY.
func TestInitRefusesAWindowManagerWithoutADisplayOrTwice(t *testing.T) {
	deadline := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	for _, test := range []struct {
		args    []string
		display string
	}{
		{[]string{"init", "--deadline", deadline, "--window-manager"}, ""},
		{[]string{"init", "--deadline", deadline, "--window-manager", "--window-manager"}, ":9"},
	} {
		t.Setenv("DISPLAY", test.display)
		code, stderr := computerd(t, 30*time.Second, test.args...)
		if code != 2 || !strings.Contains(stderr, "--window-manager") {
			t.Errorf("computerd %q with DISPLAY %q: exit %d, stderr %q; want 2 and a refusal that names --window-manager", test.args, test.display, code, stderr)
		}
	}
}
