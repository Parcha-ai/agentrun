package daemon_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/daemon"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
)

// TestMain runs this test binary as computerd's guard, init or stdio when it is started as one, or as a child of the
// Become tests.
func TestMain(m *testing.M) {
	if len(os.Args) >= 2 && os.Args[1] == daemon.BecomeChildArg {
		os.Exit(daemon.BecomeChild(os.Args[2:]))
	}
	if len(os.Args) == 2 && os.Args[1] == daemon.StatusChildArg {
		os.Exit(daemon.StatusChild())
	}
	if len(os.Args) == 2 {
		switch os.Args[1] {
		case execrun.GuardCommand:
			os.Exit(execrun.Guard())
		case "stdio":
			os.Exit(daemon.Bridge(daemon.SocketPath(), os.Stdin, os.Stdout, os.Stderr))
		}
	}
	if len(os.Args) == 3 && os.Args[1] == "init" {
		deadline, err := time.Parse(time.RFC3339Nano, os.Args[2])
		if err != nil {
			os.Exit(99)
		}
		os.Exit(daemon.Init("0.0.0-test", daemon.SocketPath(), deadline, log.New(os.Stderr, "computerd: ", 0)))
	}
	os.Exit(m.Run())
}

// patience bounds every wait in these tests. The host may be loaded: it is never a claim about speed.
const patience = 30 * time.Second

type initProcess struct {
	cmd    *exec.Cmd
	socket string
	log    *bytes.Buffer
	ended  chan error
}

// socketIn makes a fresh directory of mode, as a provider would, and returns a socket path in it.
func socketIn(t *testing.T, mode os.FileMode) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "run")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, mode); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	return filepath.Join(dir, "computerd.sock")
}

// startInit runs `computerd init` on a socket in a fresh 0700 directory, ending in an hour, and waits until it answers.
func startInit(t *testing.T) *initProcess {
	t.Helper()
	return startInitUntil(t, time.Now().Add(time.Hour))
}

func startInitUntil(t *testing.T, deadline time.Time) *initProcess {
	t.Helper()
	socket := socketIn(t, 0o700)
	in := &initProcess{socket: socket, log: &bytes.Buffer{}, ended: make(chan error, 1)}
	in.cmd = exec.Command(os.Args[0], "init", deadline.UTC().Format(time.RFC3339Nano))
	in.cmd.Env = append(os.Environ(), daemon.SocketEnv+"="+socket)
	in.cmd.Stderr = in.log
	if err := in.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { in.ended <- in.cmd.Wait() }()
	t.Cleanup(func() {
		_ = in.cmd.Process.Kill()
		<-in.ended
		in.ended <- nil
	})
	listening := time.Now().Add(patience)
	for time.Now().Before(listening) {
		if conn, err := net.Dial("unix", socket); err == nil {
			_ = conn.Close()
			return in
		}
		select {
		case err := <-in.ended:
			in.ended <- err
			t.Fatalf("init ended (%v): %s", err, in.log)
		case <-time.After(20 * time.Millisecond):
		}
	}
	t.Fatalf("init did not listen on %s: %s", socket, in.log)
	return nil
}

type reply struct {
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
		Data    struct {
			Kind string `json:"kind"`
		} `json:"data"`
	} `json:"error"`
}

// client speaks the protocol over any stream: a socket, or a bridge's stdin and stdout.
type client struct {
	t      *testing.T
	w      io.WriteCloser
	lines  chan []byte
	nextID int
}

func newClient(t *testing.T, r io.Reader, w io.WriteCloser) *client {
	c := &client{t: t, w: w, lines: make(chan []byte, 64)}
	go func() {
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 0, 64<<10), 4<<20)
		for scanner.Scan() {
			c.lines <- append([]byte(nil), scanner.Bytes()...)
		}
		close(c.lines)
	}()
	return c
}

func dial(t *testing.T, socket string) *client {
	t.Helper()
	conn, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return newClient(t, conn, conn)
}

func (c *client) call(method string, params any) reply {
	c.t.Helper()
	c.nextID++
	line, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": c.nextID, "method": method, "params": params})
	if _, err := c.w.Write(append(line, '\n')); err != nil {
		c.t.Fatalf("write %s: %v", method, err)
	}
	timeout := time.After(2 * patience)
	for {
		select {
		case line, ok := <-c.lines:
			if !ok {
				c.t.Fatalf("the daemon closed the connection during %s", method)
			}
			var r reply
			if err := json.Unmarshal(line, &r); err != nil {
				c.t.Fatalf("not JSON: %q", line)
			}
			if r.ID == c.nextID {
				return r
			}
		case <-timeout:
			c.t.Fatalf("no reply to %s", method)
		}
	}
}

func (c *client) ok(method string, params any, into any) {
	c.t.Helper()
	r := c.call(method, params)
	if r.Error != nil {
		c.t.Fatalf("%s: %s (%s)", method, r.Error.Message, r.Error.Data.Kind)
	}
	if into != nil {
		if err := json.Unmarshal(r.Result, into); err != nil {
			c.t.Fatalf("%s result %s: %v", method, r.Result, err)
		}
	}
}

type started struct {
	ID  string `json:"id"`
	Pid int    `json:"pid"`
}

type readResult struct {
	Data       []byte `json:"data"`
	NextOffset int64  `json:"nextOffset"`
	Dropped    int64  `json:"dropped"`
	Exited     bool   `json:"exited"`
}

type waited struct {
	Running  bool    `json:"running"`
	ExitCode *int    `json:"exitCode"`
	Signal   *string `json:"signal"`
}

type listed struct {
	ID      string   `json:"id"`
	Pid     int      `json:"pid"`
	Argv    []string `json:"argv"`
	Running bool     `json:"running"`
}

type listResult struct {
	Processes []listed `json:"processes"`
	Truncated bool     `json:"truncated"`
}

// readUntil reads a process's stdout from offset 0 until it holds want.
func (c *client) readUntil(id, want string) string {
	c.t.Helper()
	var out bytes.Buffer
	offset := int64(0)
	deadline := time.Now().Add(patience)
	for time.Now().Before(deadline) {
		var res readResult
		c.ok("process.read", map[string]any{"id": id, "stream": "stdout", "offset": offset, "waitMs": 1000}, &res)
		out.Write(res.Data)
		offset = res.NextOffset
		if strings.Contains(out.String(), want) {
			return out.String()
		}
		if res.Exited {
			break
		}
	}
	c.t.Fatalf("%s never wrote %q; it wrote %q", id, want, out.String())
	return ""
}

// gone waits until pid is no process or a zombie.
func gone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(patience)
	for time.Now().Before(deadline) {
		stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
		if err != nil {
			return
		}
		if fields := strings.Fields(string(stat[bytes.LastIndexByte(stat, ')')+1:])); fields[0] == "Z" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("process %d is still running", pid)
}

func pidsIn(t *testing.T, text string, n int) []int {
	t.Helper()
	var pids []int
	for _, field := range strings.Fields(text) {
		if pid, err := strconv.Atoi(field); err == nil {
			pids = append(pids, pid)
		}
	}
	if len(pids) < n {
		t.Fatalf("want %d pids in %q", n, text)
	}
	return pids[:n]
}

func TestTheSocketIsForTheDaemonsUserOnly(t *testing.T) {
	in := startInit(t)
	dir, err := os.Stat(filepath.Dir(in.socket))
	if err != nil || dir.Mode().Perm() != 0o700 {
		t.Fatalf("the socket's directory: %v %v", dir.Mode(), err)
	}
	sock, err := os.Lstat(in.socket)
	if err != nil || sock.Mode()&os.ModeSocket == 0 || sock.Mode().Perm() != 0o600 {
		t.Fatalf("the socket: %v %v", sock.Mode(), err)
	}
}

func TestAProcessOutlivesItsConnectionAndTwoConnectionsShareOneTable(t *testing.T) {
	in := startInit(t)
	a := dial(t, in.socket)
	var hello struct {
		Capabilities []string `json:"capabilities"`
	}
	a.ok("hello", map[string]any{"client": "test"}, &hello)
	if strings.Join(hello.Capabilities, ",") != "exec,files,processes" {
		t.Fatalf("capabilities %v", hello.Capabilities)
	}
	var p started
	a.ok("process.start", map[string]any{"argv": []string{"sh", "-c", "i=0; while true; do echo tick $i; i=$((i+1)); sleep 0.2; done"}}, &p)
	a.readUntil(p.ID, "tick 0")
	_ = a.w.Close()

	b := dial(t, in.socket)
	var list listResult
	b.ok("process.list", map[string]any{}, &list)
	if len(list.Processes) != 1 || list.Truncated || list.Processes[0].ID != p.ID || list.Processes[0].Pid != p.Pid || !list.Processes[0].Running {
		t.Fatalf("list from a second connection %+v", list)
	}
	b.readUntil(p.ID, "tick 3")
	var res readResult
	b.ok("process.read", map[string]any{"id": p.ID, "stream": "stdout", "offset": 0}, &res)
	first := res.NextOffset
	b.readUntil(p.ID, "tick 5")
	b.ok("process.read", map[string]any{"id": p.ID, "stream": "stdout", "offset": first}, &res)
	if res.NextOffset <= first || !strings.HasPrefix(string(res.Data), "tick ") {
		t.Fatalf("a later read from %d: %+v", first, res)
	}
	b.ok("process.signal", map[string]any{"id": p.ID, "signal": "TERM"}, nil)
	var w waited
	b.ok("process.wait", map[string]any{"id": p.ID, "timeoutMs": patience.Milliseconds()}, &w)
	if w.Running || w.ExitCode != nil || w.Signal == nil || *w.Signal != "TERM" {
		t.Fatalf("wait %+v", w)
	}
	// exec.run still runs over the same socket.
	var ran struct {
		ExitCode *int   `json:"exitCode"`
		Stdout   []byte `json:"stdout"`
	}
	b.ok("exec.run", map[string]any{"argv": []string{"echo", "hi"}, "timeoutMs": patience.Milliseconds()}, &ran)
	if ran.ExitCode == nil || *ran.ExitCode != 0 || string(ran.Stdout) != "hi\n" {
		t.Fatalf("exec.run %+v", ran)
	}
}

func TestTheBridgeCarriesAConnection(t *testing.T) {
	in := startInit(t)
	bridge := exec.Command(os.Args[0], "stdio")
	bridge.Env = append(os.Environ(), daemon.SocketEnv+"="+in.socket)
	stdin, err := bridge.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := bridge.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	bridge.Stderr = &stderr
	if err := bridge.Start(); err != nil {
		t.Fatal(err)
	}
	c := newClient(t, stdout, stdin)
	var p started
	c.ok("process.start", map[string]any{"argv": []string{"sleep", "300"}}, &p)
	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := bridge.Wait(); err != nil {
		t.Fatalf("the bridge, at the end of its input: %v: %s", err, stderr.String())
	}
	// The process outlives the bridge.
	d := dial(t, in.socket)
	var list listResult
	d.ok("process.list", map[string]any{}, &list)
	if len(list.Processes) != 1 || list.Processes[0].ID != p.ID || !list.Processes[0].Running {
		t.Fatalf("list %+v", list)
	}
}

func TestTheBridgeExits0WhenTheDaemonClosesAfterItsInputEnded(t *testing.T) {
	in := startInit(t)
	// Hold the bridge right after it half-closes, so the daemon's answering close lands before the bridge goes on.
	daemon.SetAfterHalfClose(t, func() { time.Sleep(300 * time.Millisecond) })
	var out, errOut bytes.Buffer
	code := daemon.Bridge(in.socket, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`+"\n"), &out, &errOut)
	if code != 0 {
		t.Fatalf("exit %d at the end of its input, want 0: %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), `"id":1`) {
		t.Fatalf("no reply to the ping: %q", out.String())
	}
}

func TestTheBridgeWithNoDaemonFailsInWords(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "computerd.sock")
	bridge := exec.Command(os.Args[0], "stdio")
	bridge.Env = append(os.Environ(), daemon.SocketEnv+"="+socket)
	var stdout, stderr bytes.Buffer
	bridge.Stdout, bridge.Stderr = &stdout, &stderr
	err := bridge.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() == 0 {
		t.Fatalf("the bridge with no daemon: %v", err)
	}
	if !strings.Contains(stderr.String(), "no daemon") || !strings.Contains(stderr.String(), socket) || stdout.Len() != 0 {
		t.Fatalf("stderr %q stdout %q", stderr.String(), stdout.String())
	}
}

func TestInitEndsAnOrphanWhoseGuardWasKilled(t *testing.T) {
	in := startInit(t)
	c := dial(t, in.socket)
	var p started
	// The program kills its guard only once the start has returned: a guard killed before it reports the program's
	// pid fails the start instead.
	c.ok("process.start", map[string]any{"argv": []string{"sh", "-c", "read go; sleep 305 & echo $$ $!; kill -9 $PPID; wait"}, "stdin": true}, &p)
	c.ok("process.write", map[string]any{"id": p.ID, "data": []byte("go\n")}, nil)
	pids := pidsIn(t, c.readUntil(p.ID, "\n"), 2)
	var w waited
	c.ok("process.wait", map[string]any{"id": p.ID, "timeoutMs": patience.Milliseconds()}, &w)
	if w.Running {
		t.Fatalf("wait %+v", w)
	}
	for _, pid := range pids {
		gone(t, pid)
	}
}

func TestInitEndsEveryProcessOnSIGTERMAndExits0(t *testing.T) {
	in := startInit(t)
	c := dial(t, in.socket)
	var deaf, plain started
	// A shell that ignores SIGTERM, and a child that inherits that: only the guard's SIGKILL ends them.
	c.ok("process.start", map[string]any{"argv": []string{"sh", "-c", `trap "" TERM; sleep 306 & echo $!; wait`}}, &deaf)
	c.ok("process.start", map[string]any{"argv": []string{"sleep", "307"}}, &plain)
	pids := append(pidsIn(t, c.readUntil(deaf.ID, "\n"), 1), deaf.Pid, plain.Pid)
	if err := in.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-in.ended:
		in.ended <- err
		if err != nil {
			t.Fatalf("init after SIGTERM: %v: %s", err, in.log)
		}
	case <-time.After(2 * patience):
		t.Fatalf("init did not end after SIGTERM: %s", in.log)
	}
	for _, pid := range pids {
		gone(t, pid)
	}
}

// initFails runs `computerd init` on socket and returns its log once it exits, which it must, with 1.
func initFails(t *testing.T, socket string) string {
	t.Helper()
	cmd := exec.Command(os.Args[0], "init", time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano))
	cmd.Env = append(os.Environ(), daemon.SocketEnv+"="+socket)
	var log bytes.Buffer
	cmd.Stderr = &log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	ended := make(chan error, 1)
	go func() { ended <- cmd.Wait() }()
	select {
	case err := <-ended:
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 1 {
			t.Fatalf("init on %s: %v, want exit 1: %s", socket, err, log.String())
		}
	case <-time.After(patience):
		_ = cmd.Process.Kill()
		<-ended
		t.Fatalf("init on %s still ran: %s", socket, log.String())
	}
	return log.String()
}

func TestInitFailsInWordsWhenItsSocketsDirectoryIsMissing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "missing")
	text := initFails(t, filepath.Join(dir, "computerd.sock"))
	if !strings.Contains(text, dir+" is missing") || !strings.Contains(text, "mode=0700") {
		t.Fatalf("init did not say the directory is missing and who must make it: %q", text)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("init made %s: %v", dir, err)
	}
}

func TestInitFailsInWordsWhenItsSocketsDirectoryIsNotWritable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: every directory is writable")
	}
	socket := socketIn(t, 0o500)
	if text := initFails(t, socket); !strings.Contains(text, filepath.Dir(socket)+" is not writable") {
		t.Fatalf("init did not say the directory is not writable: %q", text)
	}
}

func TestInitRefusesASocketsDirectoryOthersMayEnter(t *testing.T) {
	socket := socketIn(t, 0o750)
	if text := initFails(t, socket); !strings.Contains(text, "alone (mode 0700)") {
		t.Fatalf("init did not refuse a directory its group may enter: %q", text)
	}
}

func TestInitEndsEveryProcessAtItsDeadlineAndExits0(t *testing.T) {
	// Long enough for the processes to start on a loaded host; the test asserts what happens at the deadline, not when.
	deadline := time.Now().Add(10 * time.Second)
	in := startInitUntil(t, deadline)
	c := dial(t, in.socket)
	var deaf, plain started
	c.ok("process.start", map[string]any{"argv": []string{"sh", "-c", `trap "" TERM; sleep 308 & echo $!; wait`}}, &deaf)
	c.ok("process.start", map[string]any{"argv": []string{"sleep", "309"}}, &plain)
	pids := append(pidsIn(t, c.readUntil(deaf.ID, "\n"), 1), deaf.Pid, plain.Pid)
	select {
	case err := <-in.ended:
		in.ended <- err
		if err != nil {
			t.Fatalf("init at its deadline: %v: %s", err, in.log)
		}
	case <-time.After(time.Until(deadline) + 2*patience):
		t.Fatalf("init did not end at its deadline: %s", in.log)
	}
	if time.Now().Before(deadline) {
		t.Fatalf("init ended before its deadline: %s", in.log)
	}
	if !strings.Contains(in.log.String(), "deadline") {
		t.Errorf("init did not say the deadline ended it: %s", in.log)
	}
	for _, pid := range pids {
		gone(t, pid)
	}
}
