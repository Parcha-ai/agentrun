package apps

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/desktop"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11/xvfbtest"
)

// helperWindow is the argument that makes this test binary an app with one window: apps-test-window <instance> <class>.
const helperWindow = "apps-test-window"

// TestMain runs the guard when process.start starts this binary as one, as computerd does, and the test app.
func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == execrun.GuardCommand {
		os.Exit(execrun.Guard())
	}
	if len(os.Args) == 4 && os.Args[1] == helperWindow {
		if err := showWindow(os.Args[2], os.Args[3]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// showWindow is the test app: a window that is the app's, by its WM_CLASS and _NET_WM_PID, on $DISPLAY, until TERM.
func showWindow(instance, class string) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()
	c, err := x11.Dial(os.Getenv("DISPLAY"))
	if err != nil {
		return err
	}
	defer c.Close()
	id := c.NewID()
	if err := c.CreateWindow(id, 40, 40, 300, 200, x11.CWBackPixel, c.Pixel(200, 30, 30)); err != nil {
		return err
	}
	if err := c.ChangeProperty(id, x11.AtomWMClass, x11.AtomString, 8, []byte(instance+"\x00"+class+"\x00")); err != nil {
		return err
	}
	pidAtom, err := c.InternAtom("_NET_WM_PID", false)
	if err != nil {
		return err
	}
	if err := c.ChangeProperty(id, pidAtom, x11.AtomCardinal, 32, le32(uint32(os.Getpid()))); err != nil {
		return err
	}
	if err := c.MapWindow(id); err != nil {
		return err
	}
	if errs, err := c.Sync(); err != nil || len(errs) > 0 {
		return fmt.Errorf("the window was not shown: %v %v", err, errs)
	}
	ended := make(chan struct{})
	go func() {
		_, _ = c.NextEvent()
		close(ended)
	}()
	select {
	case <-ctx.Done():
	case <-ended:
	}
	return nil
}

func le32(v uint32) []byte { return []byte{byte(v), byte(v >> 8), byte(v >> 16), byte(v >> 24)} }

type world struct {
	t       *testing.T
	display string
	conn    *x11.Conn
	call    func(method string, params any) (any, error)
}

func setup(t *testing.T, window time.Duration) *world {
	t.Helper()
	display := xvfbtest.Start(t, 640, 480)
	dir := t.TempDir()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "test.window.desktop"), fmt.Sprintf("[Desktop Entry]\nType=Application\nName=Test Window\nExec=%q %s test TestWindow\nStartupWMClass=TestWindow\n", self, helperWindow))
	write(t, filepath.Join(dir, "quiet.desktop"), "[Desktop Entry]\nType=Application\nName=Quiet\nExec=sleep 60\n")
	d := desktop.New(display)
	t.Cleanup(d.Close)
	table := process.NewTable(process.Options{})
	handlers := Handlers(d, table, Options{Dirs: []string{dir}, Window: window})
	conn, err := x11.Dial(display)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	w := &world{t: t, display: display, conn: conn}
	w.call = func(method string, params any) (any, error) {
		raw, err := json.Marshal(params)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return handlers[method](ctx, raw)
	}
	// Whatever a test left running ends with it.
	t.Cleanup(func() {
		for _, id := range []string{"test.window", "quiet"} {
			_, _ = w.call("apps.terminate", map[string]any{"id": id})
		}
	})
	return w
}

func (w *world) list() ListResult {
	w.t.Helper()
	got, err := w.call("apps.list", map[string]any{})
	if err != nil {
		w.t.Fatalf("apps.list: %v", err)
	}
	return got.(ListResult)
}

func (w *world) foreground() string {
	w.t.Helper()
	if f := w.list().Foreground; f != nil {
		return *f
	}
	return ""
}

// shown is how many viewable windows of class there are now, read on a connection of the test's own.
func (w *world) shown(class string) int {
	w.t.Helper()
	children, err := w.conn.QueryTree(w.conn.Screen().Root)
	if err != nil {
		w.t.Fatal(err)
	}
	n := 0
	for _, child := range children {
		attrs, err := w.conn.GetWindowAttributes(child)
		if err != nil || attrs.MapState != x11.IsViewable {
			continue
		}
		p, err := w.conn.GetProperty(child, x11.AtomWMClass)
		if err == nil && strings.Contains(string(p.Value), "\x00"+class+"\x00") {
			n++
		}
	}
	return n
}

func kindOf(err error) rpc.Kind {
	var e *rpc.Error
	if errors.As(err, &e) {
		return e.Kind
	}
	return ""
}

func TestAppsListLaunchAndTerminateOnADesktop(t *testing.T) {
	w := setup(t, 5*time.Second)
	listed := w.list()
	names := map[string]string{}
	for _, app := range listed.Apps {
		names[app.ID] = app.Name
	}
	if names["test.window"] != "Test Window" || names["quiet"] != "Quiet" {
		t.Fatalf("apps.list gave %+v", listed.Apps)
	}
	if listed.Foreground != nil {
		t.Fatalf("no window shows, and the app in front is %q", *listed.Foreground)
	}

	// Launch answers once the app's window shows: no wait of the test's own.
	got, err := w.call("apps.launch", map[string]any{"id": "test.window"})
	if err != nil {
		t.Fatalf("apps.launch test.window: %v", err)
	}
	if b, _ := json.Marshal(got); string(b) != "{}" {
		t.Fatalf("apps.launch answered %s, not {}", b)
	}
	if n := w.shown("TestWindow"); n != 1 {
		t.Fatalf("right after apps.launch answered, %d of the app's windows show, not 1", n)
	}
	if f := w.foreground(); f != "test.window" {
		t.Fatalf("the app in front after apps.launch is %q, not test.window", f)
	}

	// By its name, as a person says it: the app runs with a window, so the launch answers at once and opens no other.
	if _, err := w.call("apps.launch", map[string]any{"id": "Test Window"}); err != nil {
		t.Fatalf("apps.launch by name: %v", err)
	}
	if n := w.shown("TestWindow"); n != 1 {
		t.Fatalf("after a second launch of a running app, %d of its windows show, not 1", n)
	}
	if f := w.foreground(); f != "test.window" {
		t.Fatalf("the app in front after a second launch is %q, not test.window", f)
	}

	// Terminate ends every window of the app before it answers.
	if _, err := w.call("apps.terminate", map[string]any{"id": "test.window"}); err != nil {
		t.Fatalf("apps.terminate: %v", err)
	}
	if n := w.shown("TestWindow"); n != 0 {
		t.Fatalf("after apps.terminate answered, %d of its windows still show", n)
	}
	if f := w.foreground(); f == "test.window" {
		t.Fatalf("test.window is still in front after apps.terminate")
	}
	if _, err := w.call("apps.terminate", map[string]any{"id": "test.window"}); err != nil {
		t.Fatalf("apps.terminate of an app that is not running: %v", err)
	}
}

// With a window manager (xfwm4 in a session bus of its own, as the desktops run it: src/desktop.ts WINDOW_MANAGER), the
// app's window is inside the manager's frame: launch answers once it shows and the manager has made it the active
// window, and terminate ends it.
func TestAppsUnderAWindowManager(t *testing.T) {
	for _, program := range []string{"xfwm4", "dbus-run-session"} {
		if _, err := exec.LookPath(program); err != nil {
			t.Skipf("%s is not on PATH: the window manager's case runs where it is (the box image has it)", program)
		}
	}
	w := setup(t, 5*time.Second)
	wm := exec.Command("dbus-run-session", "--", "xfwm4", "--compositor=off", "--sm-client-disable")
	// No session bus of the test's own: xfwm4 gets the one dbus-run-session starts, as on a desktop.
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "DBUS_SESSION_BUS_ADDRESS=") && !strings.HasPrefix(kv, "DISPLAY=") {
			wm.Env = append(wm.Env, kv)
		}
	}
	wm.Env = append(wm.Env, "DISPLAY="+w.display)
	if err := wm.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = wm.Process.Kill(); _ = wm.Wait() })
	check, err := w.conn.InternAtom("_NET_SUPPORTING_WM_CHECK", false)
	if err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(15 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if p, err := w.conn.GetProperty(w.conn.Screen().Root, check); err == nil && len(p.Cardinals()) > 0 && p.Cardinals()[0] != 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("xfwm4 did not take the display within 15 s")
		}
	}
	if _, err := w.call("apps.launch", map[string]any{"id": "test.window"}); err != nil {
		t.Fatalf("apps.launch under xfwm4: %v", err)
	}
	// At once: launch answered, so the manager has made the window the active one, and keys typed now reach it.
	if f := w.foreground(); f != "test.window" {
		t.Fatalf("right after apps.launch answered under xfwm4, the app in front is %q, not test.window", f)
	}
	if _, err := w.call("apps.terminate", map[string]any{"id": "test.window"}); err != nil {
		t.Fatalf("apps.terminate under xfwm4: %v", err)
	}
	if f := w.foreground(); f == "test.window" {
		t.Fatal("test.window is still in front after apps.terminate")
	}
}

func TestAppsLaunchRefusesInWords(t *testing.T) {
	w := setup(t, time.Second)
	for _, c := range []struct {
		params map[string]any
		kind   rpc.Kind
		says   string
	}{
		{map[string]any{"id": "ai.agentrun.no.such.app"}, rpc.KindNotFound, "apps.list"},
		{map[string]any{"id": "test.window", "background": true}, rpc.KindUnsupported, "front"},
		{map[string]any{"id": "quiet", "url": "https://example.com"}, rpc.KindInvalid, "url"},
		{map[string]any{"id": "quiet"}, rpc.KindTimeout, "no window within 1 s"},
	} {
		_, err := w.call("apps.launch", c.params)
		if kindOf(err) != c.kind || !strings.Contains(fmt.Sprint(err), c.says) {
			t.Errorf("apps.launch %v: %v (%q), want %s saying %q", c.params, err, kindOf(err), c.kind, c.says)
		}
	}
	if _, err := w.call("apps.terminate", map[string]any{"id": "ai.agentrun.no.such.app"}); kindOf(err) != rpc.KindNotFound {
		t.Errorf("apps.terminate of an app the desktop lacks: %v, want not_found", err)
	}
}

func TestAppsWithNoDisplayAreUnsupported(t *testing.T) {
	handlers := Handlers(desktop.New(""), process.NewTable(process.Options{}), Options{Dirs: []string{t.TempDir()}})
	for _, method := range []string{"apps.list", "apps.launch", "apps.terminate"} {
		_, err := handlers[method](context.Background(), json.RawMessage(`{"id":"x"}`))
		if method == "apps.list" {
			_, err = handlers[method](context.Background(), json.RawMessage(`{}`))
		}
		if kindOf(err) != rpc.KindUnsupported {
			t.Errorf("%s with no display: %v, want unsupported", method, err)
		}
	}
}
