// Package windowmanager is the desktop's window manager computerd starts itself (init --window-manager), for a host
// whose desktops run one: xfwm4, with no compositor and no session manager, which frames, stacks and focuses the
// windows apps.launch opens. It reads its settings from xfconfd over a session bus and exits at once without one
// ("Xfconf could not be initialized"), so it runs in a session bus of its own (dbus-run-session, bus, written to a file
// of its own under /tmp) that listens on an abstract name, which only a program in the bus's own network namespace
// reaches. Init, still root, makes that network namespace as it forks the manager's start (Start), so no user namespace
// is needed: the computer's user can make neither on some hosts (Daytona's sandboxes, under AppArmor's
// restrict_unprivileged_userns), and holds no capability to join one root made. The same uid may still ptrace xfwm4.
// The start waits until init sees the display answer (Run), then paints the screen behind every window one slate
// colour (xsetroot), so a desktop with no window open is not a black screen a person reads as broken (a paint that
// fails starts xfwm4 all the same), and becomes the manager. hello says how it goes (Fact). src/desktop.ts runs the
// same line through process.start for a computerd that says nothing of one.
package windowmanager

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/isolate"
)

// ChildArg is the subcommand init starts the manager's start as: `computerd window-manager`, given the word to start on
// fd 3.
const ChildArg = "window-manager"

// Words is what runs, as hello's words name it: without the shell line and the bus's config.
const Words = "dbus-run-session -- xfwm4 --compositor=off --sm-client-disable"

// bus is dbus's own session config, but listening on an abstract name, which only a program in the bus's own network
// namespace reaches. dbus's unix:tmpdir is a socket under /tmp with dbus 1.16 (Agent37's box), which every program of
// the user reaches.
const bus = `<busconfig>
  <type>session</type>
  <keep_umask/>
  <listen>unix:abstract=/agentrun/window-manager</listen>
  <auth>EXTERNAL</auth>
  <standard_session_servicedirs/>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>`

// script paints the root window, writes the bus's config ($1) to a file of its own and becomes the manager in that bus.
const script = `xsetroot -solid "#3b4b5c"; bus=$(mktemp) && printf "%s" "$1" > "$bus" && exec dbus-run-session --config-file="$bus" -- xfwm4 --compositor=off --sm-client-disable`

const (
	// startFD is the pipe the start reads its word on: ExtraFiles' first.
	startFD = 3
	// startWord is the line init writes once the display answers.
	startWord = "start\n"
	// settle is how long init watches the manager once started: one that ends within it could not take the display.
	settle = time.Second
	// pollEvery is how often init asks whether the display answers yet.
	pollEvery = 100 * time.Millisecond
	// keptBytes is how much of the manager's stderr and stdout init keeps, the last of it, for its words.
	keptBytes = 8 << 10
	// keptLines is how many of the last lines of that output its words carry.
	keptLines = 5
	// drainFor is how long init waits for the output's end once the manager ended: a process it left may hold the pipe.
	drainFor = 200 * time.Millisecond
	// defaultPath is the PATH the start gets when init has none.
	defaultPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
)

// The states hello reports.
const (
	// Starting: init was asked for a manager, and the display has not answered yet, or the manager is in its first second.
	Starting = "starting"
	// Running: the manager has run a second on the display.
	Running = "running"
	// Ended: it ended, or never started; Why says how, with its last lines.
	Ended = "ended"
)

// Fact is hello's windowManager: the state of the manager init starts, and with Ended, why in words.
type Fact struct {
	State string `json:"state"`
	Why   string `json:"why,omitempty"`
}

// Manager is the window manager init starts on display, as user (nil: init's own uid), from home.
type Manager struct {
	display string
	home    string
	user    *syscall.Credential

	mu      sync.Mutex
	fact    Fact
	started bool // the start word was written
	pid     int
	start   *os.File
	ended   chan struct{}
	out     *tail
}

// New is the manager init starts on display as uid:gid (user false: as init's own uid), from home.
func New(display, home string, user bool, uid, gid int) *Manager {
	m := &Manager{display: display, home: home, fact: Fact{State: Starting}, ended: make(chan struct{}), out: &tail{}}
	if user {
		m.user = &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid), Groups: []uint32{}}
	}
	return m
}

// Start forks the manager's start: `computerd window-manager`, in a network namespace of its own, which this process
// makes as it forks, as the user, in a session of its own. It runs while init is still root (CAP_SYS_ADMIN to make the
// namespace, CAP_SETUID and CAP_SETGID to become the user), after no_new_privs is set and the bounding set emptied on
// every thread, so the start holds no capability once it runs and can gain none. A start that cannot fork is kept as
// the fact, Ended with why, for hello to say: init goes on, and the client fails create in those words.
func (m *Manager) Start() {
	if m == nil {
		return
	}
	read, write, err := os.Pipe()
	if err != nil {
		m.end(fmt.Sprintf("computerd could not start the window manager (%s) on %s: a pipe for its start: %v", Words, m.display, err))
		return
	}
	outRead, outWrite, err := os.Pipe()
	if err != nil {
		_ = read.Close()
		_ = write.Close()
		m.end(fmt.Sprintf("computerd could not start the window manager (%s) on %s: a pipe for its output: %v", Words, m.display, err))
		return
	}
	path := os.Getenv("PATH")
	if path == "" {
		path = defaultPath
	}
	cmd := &exec.Cmd{
		Path:        "/proc/self/exe",
		Args:        []string{"computerd", ChildArg},
		Env:         []string{"PATH=" + path, "HOME=" + m.home, "DISPLAY=" + m.display, "NO_AT_BRIDGE=1"},
		Dir:         m.home,
		Stdout:      outWrite,
		Stderr:      outWrite,
		ExtraFiles:  []*os.File{read},
		SysProcAttr: &syscall.SysProcAttr{Cloneflags: syscall.CLONE_NEWNET, Credential: m.user, Setsid: true},
	}
	err = cmd.Start()
	_ = read.Close()
	_ = outWrite.Close()
	if err != nil {
		_ = write.Close()
		_ = outRead.Close()
		m.end(fmt.Sprintf("computerd could not start the window manager (%s) on %s in a network namespace of its own: %v", Words, m.display, err))
		return
	}
	m.mu.Lock()
	m.pid, m.start = cmd.Process.Pid, write
	m.mu.Unlock()
	drained := make(chan struct{})
	go func() {
		_, _ = io.Copy(m.out, outRead)
		_ = outRead.Close()
		close(drained)
	}()
	go func() {
		err := cmd.Wait()
		select {
		case <-drained:
		case <-time.After(drainFor):
		}
		m.finished(err)
	}()
}

// Pid is the manager's start, init's child, which init's sweep leaves to it; 0 when none was started.
func (m *Manager) Pid() int {
	if m == nil {
		return 0
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.pid
}

// Run waits until answers says the display answers, then starts the manager and watches it for settle: one that ends
// within it is Ended in words, else it is Running. It returns at once when nothing was started, and when ctx ends.
func (m *Manager) Run(ctx context.Context, answers func() bool) {
	if m == nil || m.Pid() == 0 {
		return
	}
	tick := time.NewTicker(pollEvery)
	defer tick.Stop()
	for !answers() {
		select {
		case <-ctx.Done():
			return
		case <-m.ended:
			return
		case <-tick.C:
		}
	}
	m.mu.Lock()
	m.started = true
	_, err := m.start.WriteString(startWord)
	_ = m.start.Close()
	m.mu.Unlock()
	if err != nil {
		// The start ended before it was told: its waiter says how.
		return
	}
	select {
	case <-ctx.Done():
	case <-m.ended:
	case <-time.After(settle):
		m.mu.Lock()
		if m.fact.State == Starting {
			m.fact = Fact{State: Running}
		}
		m.mu.Unlock()
	}
}

// Fact is what hello says of the manager; nil when init was not asked for one.
func (m *Manager) Fact() *Fact {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	fact := m.fact
	return &fact
}

// end keeps why as the fact, Ended, and closes ended.
func (m *Manager) end(why string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.fact = Fact{State: Ended, Why: why}
	close(m.ended)
}

// finished keeps the start's end, err cmd.Wait's, in words with its last lines: before it was told to start, within
// its first second, or after.
func (m *Manager) finished(err error) {
	how := "ended"
	var exit *exec.ExitError
	switch {
	case errors.As(err, &exit) && exit.Exited():
		how = fmt.Sprintf("ended with exit code %d", exit.ExitCode())
	case errors.As(err, &exit):
		if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			how = fmt.Sprintf("ended with signal %s", status.Signal())
		}
	case err == nil:
		how = "ended with exit code 0"
	default:
		how = fmt.Sprintf("ended (%v)", err)
	}
	m.mu.Lock()
	started, state := m.started, m.fact.State
	m.mu.Unlock()
	when := "before the display answered"
	switch {
	case started && state == Running:
		when = "after it started"
	case started:
		when = fmt.Sprintf("within %d s of starting", settle/time.Second)
	}
	why := fmt.Sprintf("the window manager computerd started (%s) %s %s on %s", Words, how, when, m.display)
	if words := m.out.lastLines(keptLines); words != "" {
		why += ": " + words
	}
	m.end(why)
}

// Child is the manager's start, in the network namespace init made, as the user: it empties its capability sets (a
// start forked as init's own uid, root in a user namespace, would carry init's into the script by its inheritable set),
// takes vsock and io_uring from itself (isolate.DenySockets, as init's programs have them taken), waits for init's word
// on fd 3, and becomes the script. An end of the pipe with no word (init is gone, or never saw the display) exits 0,
// starting nothing. Its exit code is 125 when it could not start the script.
//
// It is the reaper of its script's orphans (PR_SET_CHILD_SUBREAPER, kept across exec): the xfconfd the manager's bus
// starts for it is left by the bus's activation, and an orphan that reached init would be one init's sweep kills
// (daemon.sweep), leaving xfwm4 to start one again on every settings read. dbus-run-session, which the script becomes,
// reaps them (waitpid(-1)); once it ends, what is left is init's, and swept.
func Child() int {
	syscall.CloseOnExec(startFD)
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetChildSubreaper, 1, 0); errno != 0 {
		fmt.Fprintf(os.Stderr, "computerd window-manager: cannot reap its orphans (PR_SET_CHILD_SUBREAPER): %v\n", errno)
		return 125
	}
	if err := noCapabilities(); err != nil {
		fmt.Fprintf(os.Stderr, "computerd window-manager: %v\n", err)
		return 125
	}
	if err := isolate.DenySockets(); err != nil {
		fmt.Fprintf(os.Stderr, "computerd window-manager: %v\n", err)
		return 125
	}
	word, err := bufio.NewReader(os.NewFile(startFD, "start")).ReadString('\n')
	if err != nil || word != startWord {
		return 0
	}
	sh, err := exec.LookPath("sh")
	if err != nil {
		fmt.Fprintf(os.Stderr, "computerd window-manager: no sh on PATH: %v\n", err)
		return 125
	}
	err = syscall.Exec(sh, []string{"sh", "-c", script, "sh", bus}, os.Environ())
	fmt.Fprintf(os.Stderr, "computerd window-manager: %s: %v\n", sh, err)
	return 125
}

// The capset call's header and sets, as linux/capability.h has them (version 3: two 32-bit words per set).
type (
	capHeader struct {
		version uint32
		pid     int32
	}
	capData struct{ effective, permitted, inheritable uint32 }
)

const (
	capVersion3          = 0x20080522
	prCapAmbient         = 47
	prCapAmbientClearAll = 4
	prSetChildSubreaper  = 36
)

// The capset call's arguments, kept where the call reads them while it runs on every thread.
var (
	noCapsHeader = capHeader{version: capVersion3}
	noCapsData   [2]capData
)

// noCapabilities empties the ambient, effective, permitted and inheritable sets of every thread. A kernel with no
// ambient set (EINVAL) has none to empty.
func noCapabilities() error {
	if _, _, errno := syscall.AllThreadsSyscall6(syscall.SYS_PRCTL, prCapAmbient, prCapAmbientClearAll, 0, 0, 0, 0); errno != 0 && errno != syscall.EINVAL {
		return fmt.Errorf("cannot empty the ambient capability set: %w", errno)
	}
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_CAPSET, uintptr(unsafe.Pointer(&noCapsHeader)), uintptr(unsafe.Pointer(&noCapsData[0])), 0); errno != 0 {
		return fmt.Errorf("cannot empty the capability sets: %w", errno)
	}
	return nil
}

// tail keeps the last keptBytes written to it.
type tail struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - keptBytes; over > 0 {
		t.buf = append([]byte(nil), t.buf[over:]...)
	}
	return len(p), nil
}

// lastLines is the last n lines kept, joined by "; ".
func (t *tail) lastLines(n int) string {
	t.mu.Lock()
	text := strings.TrimSpace(string(t.buf))
	t.mu.Unlock()
	if text == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "; ")
}
