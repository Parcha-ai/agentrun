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
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/desktop"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/proctree"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11/xvfbtest"
)

// helperWindow is the argument that makes this test binary an app with one window: apps-test-window <instance> <class>.
const helperWindow = "apps-test-window"

// helperSingle makes this test binary an app that runs once, as Firefox does: apps-test-single <dir> <class> <second>
// [url]. The first instance holds <dir>/lock and shows a window. A later one finds the lock and, by <second>: "hand"
// writes its url to <dir>/handed and ends, as a launcher that hands the url to the instance that runs; "dialog" shows a
// dialog of its own, "Close <class>", and runs on, as Firefox's "already running" box when its second launch can't
// reach the first; "spawn" starts a process in a session of its own that shows that dialog and ignores TERM
// ("stubborn"), and runs on until TERM; "leave" starts a process in a session of its own that shows that dialog a moment
// later ("late") and ends at once, exit code 0, leaving it behind.
const helperSingle = "apps-test-single"

// helperFlagged makes this test binary an app that takes a flag as Chromium does: apps-test-flagged [url]. A url that
// is --renderer-cmd-prefix=<command> runs the command (Chromium runs its renderers under it); then the app shows a
// window, WM_CLASS Flagged.
const helperFlagged = "apps-test-flagged"

// TestMain runs the guard when process.start starts this binary as one, as computerd does, and the test apps.
func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == execrun.GuardCommand {
		os.Exit(execrun.Guard())
	}
	if len(os.Args) == 4 && os.Args[1] == helperWindow {
		os.Exit(exit(showWindow(os.Args[2], os.Args[3], false)))
	}
	if len(os.Args) >= 5 && os.Args[1] == helperSingle {
		os.Exit(single(os.Args[2], os.Args[3], os.Args[4], os.Args[5:]))
	}
	if len(os.Args) >= 2 && os.Args[1] == helperFlagged {
		os.Exit(flagged(os.Args[2:]))
	}
	os.Exit(m.Run())
}

// flagged is the app helperFlagged names.
func flagged(args []string) int {
	for _, arg := range args {
		if command, ok := strings.CutPrefix(arg, "--renderer-cmd-prefix="); ok {
			if err := exec.Command("sh", "-c", command).Run(); err != nil {
				return exit(err)
			}
		}
	}
	return exit(showWindow("flagged", "Flagged", false))
}

func exit(err error) int {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// single is the app helperSingle names.
func single(dir, class, second string, url []string) int {
	lock := filepath.Join(dir, "lock")
	if f, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600); err == nil {
		_ = f.Close()
		defer os.Remove(lock)
		return exit(showWindow(strings.ToLower(class), class, false))
	}
	switch second {
	case "hand":
		return exit(os.WriteFile(filepath.Join(dir, "handed"), []byte(strings.Join(url, " ")), 0o600))
	case "dialog":
		return exit(showWindow(strings.ToLower(class), class, true))
	case "stubborn":
		signal.Ignore(syscall.SIGTERM)
		return exit(showWindow(strings.ToLower(class), class, true))
	case "spawn":
		child := exec.Command(os.Args[0], helperSingle, dir, class, "stubborn")
		child.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err := child.Start(); err != nil {
			return exit(err)
		}
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
		defer stop()
		<-ctx.Done()
		return 0
	case "leave":
		child := exec.Command(os.Args[0], helperSingle, dir, class, "late")
		child.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		return exit(child.Start())
	case "late":
		time.Sleep(500 * time.Millisecond)
		return exit(showWindow(strings.ToLower(class), class, true))
	}
	return 2
}

// showWindow is the test app: a window that is the app's, by its WM_CLASS and _NET_WM_PID, on $DISPLAY, until TERM. A
// dialog is one by its EWMH type (_NET_WM_WINDOW_TYPE_DIALOG), named "Close <class>".
func showWindow(instance, class string, dialog bool) error {
	// Until TERM, unless the app ignores it ("stubborn").
	ctx := context.Background()
	if !signal.Ignored(syscall.SIGTERM) {
		var stop context.CancelFunc
		ctx, stop = signal.NotifyContext(ctx, syscall.SIGTERM)
		defer stop()
	}
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
	if dialog {
		atoms := map[string]uint32{}
		for _, name := range []string{"ATOM", "_NET_WM_WINDOW_TYPE", "_NET_WM_WINDOW_TYPE_DIALOG"} {
			if atoms[name], err = c.InternAtom(name, false); err != nil {
				return err
			}
		}
		if err := c.ChangeProperty(id, atoms["_NET_WM_WINDOW_TYPE"], atoms["ATOM"], 32, le32(atoms["_NET_WM_WINDOW_TYPE_DIALOG"])); err != nil {
			return err
		}
		if err := c.ChangeProperty(id, x11.AtomWMName, x11.AtomString, 8, []byte("Close "+class)); err != nil {
			return err
		}
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
	table   *process.Table
	call    func(method string, params any) (any, error)
	// locks is each helperSingle app's folder, by its second launch's way: "hand", "dialog", "spawn" or "leave".
	locks map[string]string
}

// running are the processes of the table that still run, by their program.
func (w *world) running(program string) int {
	w.t.Helper()
	listed, err := w.table.List(process.ListParams{})
	if err != nil {
		w.t.Fatal(err)
	}
	n := 0
	for _, p := range listed.Processes {
		if p.Running && len(p.Argv) > 0 && p.Argv[0] == program {
			n++
		}
	}
	return n
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
	write(t, filepath.Join(dir, "flagged.desktop"), fmt.Sprintf("[Desktop Entry]\nType=Application\nName=Flagged\nExec=%q %s %%u\nStartupWMClass=Flagged\n", self, helperFlagged))
	// Apps that run once (helperSingle), each with a folder of its own for its lock: one that hands a later launch's url
	// to the instance that runs, one that shows a dialog instead, one whose dialog is a stubborn process it started, one
	// whose dialog is a process it started and left.
	locks := map[string]string{}
	for _, second := range []string{"hand", "dialog", "spawn", "leave"} {
		lock := filepath.Join(t.TempDir(), second)
		if err := os.Mkdir(lock, 0o700); err != nil {
			t.Fatal(err)
		}
		locks[second] = lock
		class := "Single" + strings.ToUpper(second[:1]) + second[1:]
		write(t, filepath.Join(dir, "single."+second+".desktop"), fmt.Sprintf("[Desktop Entry]\nType=Application\nName=%s\nExec=%q %s %q %s %s %%u\nStartupWMClass=%s\n", class, self, helperSingle, lock, class, second, class))
	}
	d := desktop.New(display)
	t.Cleanup(d.Close)
	table := process.NewTable(process.Options{})
	// The test wrote the apps' desktop files, so they are held out of reach of a stranger, not of the test's own user.
	handlers := Handlers(d, table, Options{Dirs: []string{dir}, Window: window, Writer: &stranger})
	conn, err := x11.Dial(display)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	w := &world{t: t, display: display, conn: conn, table: table, locks: locks}
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
		for _, id := range []string{"test.window", "quiet", "flagged", "single.hand", "single.dialog", "single.spawn", "single.leave"} {
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

// A url for an app that runs is handed over by a second launch. One whose launcher passes it to the instance that runs
// and ends (Chromium's, or Firefox's with a session bus) opened it: the call answers, and no window more shows.
func TestAppsLaunchAURLIntoARunningAppThatTakesIt(t *testing.T) {
	w := setup(t, 5*time.Second)
	self, _ := os.Executable()
	if _, err := w.call("apps.launch", map[string]any{"id": "single.hand"}); err != nil {
		t.Fatalf("apps.launch single.hand: %v", err)
	}
	if _, err := w.call("apps.launch", map[string]any{"id": "single.hand", "url": "https://example.com/two"}); err != nil {
		t.Fatalf("apps.launch single.hand with a url, its launcher handing it over: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(w.locks["hand"], "handed")); err != nil || string(b) != "https://example.com/two" {
		t.Fatalf("the running instance was handed %q (%v), not the url", b, err)
	}
	if n, ran := w.shown("SingleHand"), w.running(self); n != 1 || ran != 1 {
		t.Fatalf("after the hand-over, %d windows show and %d launches run, not 1 and 1", n, ran)
	}
}

// Firefox runs once a profile, and its second launch hands a url to the first over a session bus only, which an app here
// has none of: the launch shows Firefox's "already running" box and runs on. That launch opened nothing, so the call
// fails in words, naming the box, and the launch is ended (its box goes); the app that ran runs on, its window as it was.
func TestAppsLaunchAURLIntoARunningAppThatShowsADialogInstead(t *testing.T) {
	w := setup(t, 5*time.Second)
	self, _ := os.Executable()
	if _, err := w.call("apps.launch", map[string]any{"id": "single.dialog"}); err != nil {
		t.Fatalf("apps.launch single.dialog: %v", err)
	}
	got, err := w.call("apps.launch", map[string]any{"id": "single.dialog", "url": "https://example.com/two"})
	if err == nil {
		t.Fatalf("apps.launch with a url into the running app answered %v (opened), though its launch showed only its own dialog", got)
	}
	if kindOf(err) != rpc.KindUnsupported || !strings.Contains(err.Error(), `"Close SingleDialog"`) || !strings.Contains(err.Error(), "did not hand it the url") {
		t.Fatalf("apps.launch with a url into the running app: %v (%q), want unsupported naming its dialog", err, kindOf(err))
	}
	if n, ran := w.shown("SingleDialog"), w.running(self); n != 1 || ran != 1 {
		t.Fatalf("after the refused hand-over, %d windows show and %d launches run, not 1 and 1: the dialog's launch was left", n, ran)
	}
	if f := w.foreground(); f != "single.dialog" {
		t.Fatalf("the app in front after the refused hand-over is %q, not single.dialog", f)
	}
}

// The dialog may be a process the launch started, in a session of its own and deaf to TERM: the launch ends on TERM,
// and its dialog goes only by a signal of its own, KILL after the grace. The call answers once it went.
func TestAppsLaunchAURLEndsADialogItsLaunchStarted(t *testing.T) {
	w := setup(t, 5*time.Second)
	if _, err := w.call("apps.launch", map[string]any{"id": "single.spawn"}); err != nil {
		t.Fatalf("apps.launch single.spawn: %v", err)
	}
	_, err := w.call("apps.launch", map[string]any{"id": "single.spawn", "url": "https://example.com/two"})
	if n := w.shown("SingleSpawn"); n != 1 {
		t.Fatalf("after the refused hand-over (%v), %d windows of the app show, not 1: its dialog outlived the launch", err, n)
	}
	if kindOf(err) != rpc.KindUnsupported || !strings.Contains(err.Error(), `"Close SingleSpawn"`) || !strings.Contains(err.Error(), "That launch was ended,") {
		t.Fatalf("apps.launch with a url into the running app: %v (%q), want unsupported, its dialog ended", err, kindOf(err))
	}
}

// A launcher may end at once, exit code 0, and leave a process of its own that shows the dialog a moment later: it ran
// under the launch's guard, so it is the launch's. The call waits while it runs, refuses once its dialog shows, and ends it.
func TestAppsLaunchAURLEndsADialogItsLauncherLeft(t *testing.T) {
	w := setup(t, 5*time.Second)
	if _, err := w.call("apps.launch", map[string]any{"id": "single.leave"}); err != nil {
		t.Fatalf("apps.launch single.leave: %v", err)
	}
	got, err := w.call("apps.launch", map[string]any{"id": "single.leave", "url": "https://example.com/two"})
	if err == nil {
		t.Fatalf("apps.launch with a url into the running app answered %v (opened), though its launcher left only a dialog", got)
	}
	if kindOf(err) != rpc.KindUnsupported || !strings.Contains(err.Error(), `"Close SingleLeave"`) || !strings.Contains(err.Error(), "That launch was ended,") {
		t.Fatalf("apps.launch with a url into the running app: %v (%q), want unsupported, its dialog ended", err, kindOf(err))
	}
	if n := w.shown("SingleLeave"); n != 1 {
		t.Fatalf("after the refused hand-over, %d windows of the app show, not 1: its dialog outlived the launch", n)
	}
}

// The race under the test above, made certain: the launcher has ended (and its guard reaped it) before the launch's
// tree is read, and what it left runs in a session of its own. That is still the launch's, so it lingers.
func TestALaunchLingersWhenItsLauncherEndedBeforeItsTreeWasRead(t *testing.T) {
	table := process.NewTable(process.Options{})
	// The launcher ends only once what it left is in a session of its own, so its group holds nothing of the launch's.
	ready := filepath.Join(t.TempDir(), "ready")
	started, err := table.Start(context.Background(), process.StartParams{
		Argv: []string{"sh", "-c", `setsid sh -c 'touch "$0"; exec sleep 30' "$0" </dev/null >/dev/null 2>&1 &
while [ ! -e "$0" ]; do sleep 0.01; done`, ready}, Orphans: "keep"})
	if err != nil {
		t.Fatalf("process.start: %v", err)
	}
	guard := table.Guard(started.ID)
	t.Cleanup(func() {
		for _, pid := range proctree.Descendants(guard) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	})
	timeout := int64(5000)
	if waited, err := table.Wait(context.Background(), process.WaitParams{ID: started.ID, TimeoutMs: &timeout}); err != nil || waited.Running {
		t.Fatalf("the launcher did not end: %+v %v", waited, err)
	}
	if parentOf(started.Pid) != 0 {
		t.Fatalf("the launcher %d is still in /proc after it ended", started.Pid)
	}
	if tree := treeOf(started.Pid, guard); !tree.lingers() {
		t.Fatalf("the launch's tree (guard %d) does not linger, though the launcher left a process under its guard: %v",
			tree.guard, proctree.Descendants(guard))
	}
}

// With a window manager (xfwm4 in a session bus of its own, as the desktops run it, internal/windowmanager, here
// without its network namespace; test/docker/desktop-xfwm4.docker.test.mjs has computerd start it), the app's window is inside the manager's frame: launch answers once it shows and the manager has made it the active
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

// A url that is a flag or a relative path is refused before anything starts: no launch is in the process table, and the
// command a flag would have run never ran. The app runs a --renderer-cmd-prefix flag's command as Chromium does, so a
// flag that reached it would have run its command.
func TestAppsLaunchRefusesAFlagOrARelativePathAndStartsNothing(t *testing.T) {
	w := setup(t, time.Second)
	ran := filepath.Join(t.TempDir(), "ran")
	for _, c := range []struct{ url, says string }{
		{"--renderer-cmd-prefix=touch " + ran, `starts with "-": the app would take it as a flag`},
		{" \t-new-instance", `starts with "-": the app would take it as a flag`},
		{"notes.txt", "is neither an absolute URL with a scheme"},
		{"../etc/passwd", "is neither an absolute URL with a scheme"},
	} {
		_, err := w.call("apps.launch", map[string]any{"id": "flagged", "url": c.url})
		if kindOf(err) != rpc.KindInvalid || !strings.Contains(fmt.Sprint(err), c.says) {
			t.Errorf("apps.launch flagged with url %q: %v (%q), want invalid saying %q", c.url, err, kindOf(err), c.says)
		}
	}
	listed, err := w.table.List(process.ListParams{})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Processes) != 0 {
		t.Errorf("refused launches started %d processes: %+v", len(listed.Processes), listed.Processes)
	}
	if _, err := os.Stat(ran); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the flag's command ran: %v", err)
	}
}

// An app runs its desktop file's Exec, so one whose desktop file computerd's own user could change runs whatever that
// user writes there: an agent given the files group's write, with exec off, would have a shell. Such an app is left out
// of apps.list, and apps.launch refuses it denied, naming the file, by its id or its name, and starts nothing. That
// holds for a desktop file the user wrote, and for one the user made read-only in a read-only folder (a tar pushed with
// those modes): the user still owns both, so it may make them writable again.
func TestAppsLeavesOutAnAppItsUserCouldChange(t *testing.T) {
	display := xvfbtest.Start(t, 640, 480)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	written := filepath.Join(dir, "written.desktop")
	write(t, written, fmt.Sprintf("[Desktop Entry]\nType=Application\nName=Written\nExec=%q %s written Written\n", self, helperWindow))
	locked := filepath.Join(dir, "locked", "app.desktop")
	write(t, locked, fmt.Sprintf("[Desktop Entry]\nType=Application\nName=Locked\nExec=%q %s locked Locked\n", self, helperWindow))
	if err := os.Chmod(locked, 0o444); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Dir(locked), 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Dir(locked), 0o755) })
	d := desktop.New(display)
	t.Cleanup(d.Close)
	table := process.NewTable(process.Options{})
	handlers := Handlers(d, table, Options{Dirs: []string{dir}, Window: time.Second})
	call := func(method string, params any) (any, error) {
		raw, err := json.Marshal(params)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return handlers[method](ctx, raw)
	}
	t.Cleanup(func() {
		for _, id := range []string{"written", "locked-app"} {
			_, _ = call("apps.terminate", map[string]any{"id": id})
		}
	})
	listed, err := call("apps.list", map[string]any{})
	if err != nil {
		t.Fatalf("apps.list: %v", err)
	}
	if apps := listed.(ListResult).Apps; len(apps) != 0 {
		t.Errorf("apps.list gave apps whose desktop files computerd's user could change: %+v", apps)
	}
	for _, c := range []struct{ id, file string }{
		{"written", written},
		{"Written", written},
		{"locked-app", locked},
	} {
		_, err := call("apps.launch", map[string]any{"id": c.id})
		if kindOf(err) != rpc.KindDenied || !strings.Contains(fmt.Sprint(err), c.file) {
			t.Errorf("apps.launch %s: %v (%q), want denied naming %s", c.id, err, kindOf(err), c.file)
		}
	}
	processes, err := table.List(process.ListParams{})
	if err != nil {
		t.Fatal(err)
	}
	if len(processes.Processes) != 0 {
		t.Errorf("refused launches started %d processes: %+v", len(processes.Processes), processes.Processes)
	}
}

// A launch that showed no window runs on (the timeout says terminate ends it), and terminate ends it before it answers,
// though there is no window of it to go.
func TestAppsTerminateEndsALaunchWithNoWindow(t *testing.T) {
	w := setup(t, 300*time.Millisecond)
	if _, err := w.call("apps.launch", map[string]any{"id": "quiet"}); kindOf(err) != rpc.KindTimeout {
		t.Fatalf("apps.launch quiet: %v, want timeout", err)
	}
	if n := w.running("sleep"); n != 1 {
		t.Fatalf("after a launch that showed no window, %d of its processes run, not 1", n)
	}
	if _, err := w.call("apps.terminate", map[string]any{"id": "quiet"}); err != nil {
		t.Fatalf("apps.terminate quiet: %v", err)
	}
	if n := w.running("sleep"); n != 0 {
		t.Fatalf("after apps.terminate answered, %d of the app's processes still run", n)
	}
}

// An app starts with no session bus (DBUS_SESSION_BUS_ADDRESS=disabled:), so it autolaunches none, and with
// NO_AT_BRIDGE=1, so its toolkit (GTK) asks for no accessibility bus. On E2B Desktop, Mousepad's autolaunched bus
// started gnome-keyring-daemon, a socket of the user's under its home (~/.cache/keyring-*/control), and an
// at-spi-bus-launcher.
func TestAppsLaunchWithNoSessionBus(t *testing.T) {
	w := setup(t, 300*time.Millisecond)
	if _, err := w.call("apps.launch", map[string]any{"id": "quiet"}); kindOf(err) != rpc.KindTimeout {
		t.Fatalf("apps.launch quiet: %v, want timeout", err)
	}
	listed, err := w.table.List(process.ListParams{})
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range listed.Processes {
		if !p.Running || len(p.Argv) == 0 || p.Argv[0] != "sleep" {
			continue
		}
		environ, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", p.Pid))
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{"DBUS_SESSION_BUS_ADDRESS=disabled:", "NO_AT_BRIDGE=1"} {
			if !slices.Contains(strings.Split(string(environ), "\x00"), want) {
				t.Fatalf("the launched app's environment has no %s: %q", want, environ)
			}
		}
		return
	}
	t.Fatal("the launched app is not running")
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
