//go:build linux

package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// fakeSys records every call and fails the one named in failAt.
type fakeSys struct {
	calls   []string
	failAt  string
	lastCap int
	fds     []int
	ppids   []int
	status  func(f *fakeSys) string
	kills   []error
	live    []int

	// own's
	realUID  int
	root     bool
	onlyCaps *uint64
	owners   func(int) bool

	// state the exec snapshot checks
	groups     []int
	uid, gid   int
	capsZero   bool
	noNewPrivs bool
	execState  string
}

var errInjected = errors.New("injected")

func newFake(lastCap int) *fakeSys {
	return &fakeSys{lastCap: lastCap, fds: []int{0, 1, 2}, ppids: []int{4242, 4242}}
}

func (f *fakeSys) step(op, detail string) error {
	call := op
	if detail != "" {
		call += " " + detail
	}
	f.calls = append(f.calls, call)
	if f.failAt == op || f.failAt == call {
		return errInjected
	}
	return nil
}

func (f *fakeSys) Setgroups(g []int) error {
	if err := f.step("setgroups", fmt.Sprint(g)); err != nil {
		return err
	}
	f.groups = append([]int(nil), g...)
	return nil
}

func (f *fakeSys) Setresgid(r, e, s int) error {
	if err := f.step("setresgid", fmt.Sprint(r, e, s)); err != nil {
		return err
	}
	f.gid = r
	return nil
}

func (f *fakeSys) Setresuid(r, e, s int) error {
	if err := f.step("setresuid", fmt.Sprint(r, e, s)); err != nil {
		return err
	}
	f.uid = r
	return nil
}

func (f *fakeSys) CapLastCap() (int, error) { return f.lastCap, f.step("cap_last_cap", "") }
func (f *fakeSys) CapbsetDrop(c int) error  { return f.step("capbset_drop", fmt.Sprint(c)) }
func (f *fakeSys) AmbientClearAll() error   { return f.step("ambient_clear", "") }

func (f *fakeSys) CapsetZero() error {
	if err := f.step("capset_zero", ""); err != nil {
		return err
	}
	f.capsZero = true
	return nil
}

func (f *fakeSys) SetNoNewPrivs() error {
	if err := f.step("no_new_privs", ""); err != nil {
		return err
	}
	f.noNewPrivs = true
	return nil
}

func (f *fakeSys) SetPdeathsig() error { return f.step("pdeathsig", "") }

func (f *fakeSys) Getppid() int {
	f.calls = append(f.calls, "getppid")
	p := f.ppids[0]
	if len(f.ppids) > 1 {
		f.ppids = f.ppids[1:]
	}
	return p
}

func (f *fakeSys) Umask(m int) int {
	f.calls = append(f.calls, fmt.Sprintf("umask %#o", m))
	return 0o022
}

// statusFor renders what the kernel would show for the fake's state.
func statusFor(f *fakeSys) string {
	caps := "000001ffffffffff"
	if f.capsZero {
		caps = "0000000000000000"
	}
	if f.onlyCaps != nil {
		caps = fmt.Sprintf("%016x", *f.onlyCaps)
		return fmt.Sprintf("Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t1000 \nNoNewPrivs:\t0\nCapInh:\t%s\nCapPrm:\t%s\nCapEff:\t%s\nCapBnd:\t000001ffffffffff\nCapAmb:\t%s\n", "0000000000000000", caps, caps, "0000000000000000")
	}
	nnp := 0
	if f.noNewPrivs {
		nnp = 1
	}
	g := strings.Trim(fmt.Sprint(f.groups), "[]")
	return sampleStatus(f.uid, f.gid, g, caps, nnp)
}

func (f *fakeSys) ReadStatus() (string, error) {
	if err := f.step("read_status", ""); err != nil {
		return "", err
	}
	if f.status != nil {
		return f.status(f), nil
	}
	return statusFor(f), nil
}

func (f *fakeSys) ListFds() ([]int, error) { return f.fds, f.step("list_fds", "") }
func (f *fakeSys) CloseFd(fd int) error    { return f.step("close_fd", fmt.Sprint(fd)) }

func (f *fakeSys) Exec(p string, argv, env []string) error {
	f.execState = fmt.Sprintf("uid=%d gid=%d groups=%v capsZero=%v nnp=%v", f.uid, f.gid, f.groups, f.capsZero, f.noNewPrivs)
	return f.step("exec", p+" "+fmt.Sprint(argv))
}

func (f *fakeSys) Kill(pid int, sig syscall.Signal) error {
	if err := f.step("kill", fmt.Sprint(pid, int(sig))); err != nil {
		return err
	}
	if len(f.kills) == 0 {
		return syscall.ESRCH
	}
	e := f.kills[0]
	f.kills = f.kills[1:]
	return e
}

func (f *fakeSys) LiveProcs(uid int) (int, error) {
	if err := f.step("live_procs", fmt.Sprint(uid)); err != nil {
		return 0, err
	}
	if len(f.live) == 0 {
		return 1, nil
	}
	n := f.live[0]
	f.live = f.live[1:]
	return n, nil
}

func (f *fakeSys) Sleep(d time.Duration) { f.calls = append(f.calls, "sleep") }

func (f *fakeSys) CapsetOnly(mask uint64) error {
	if err := f.step("capset_only", fmt.Sprintf("%#x", mask)); err != nil {
		return err
	}
	f.onlyCaps = &mask
	return nil
}

func (f *fakeSys) Getuid() int {
	if f.realUID == 0 && !f.root {
		return 1000
	}
	return f.realUID
}

func (f *fakeSys) Own(dir string, owned func(int) bool, runner, uid, gid int, stderr io.Writer) bool {
	f.owners = owned
	return f.step("own", fmt.Sprint(dir, " runner=", runner, " uid=", uid, " gid=", gid)) == nil
}

func sampleStatus(uid, gid int, groups, caps string, nnp int) string {
	return fmt.Sprintf(`Name:	true
State:	R (running)
Pid:	77
PPid:	1
Uid:	%d	%d	%d	%d
Gid:	%d	%d	%d	%d
FDSize:	64
Groups:	%s
NoNewPrivs:	%d
Seccomp:	0
CapInh:	%s
CapPrm:	%s
CapEff:	%s
CapBnd:	%s
CapAmb:	%s
`, uid, uid, uid, uid, gid, gid, gid, gid, groups+" ", nnp, caps, caps, caps, caps, caps)
}

func dropSeq(id int, groups []int, lastCap int) []string {
	seq := []string{
		"setgroups " + fmt.Sprint(groups),
		fmt.Sprintf("setresgid %d %d %d", id, id, id),
		fmt.Sprintf("setresuid %d %d %d", id, id, id),
		"cap_last_cap",
	}
	for c := 0; c <= lastCap; c++ {
		seq = append(seq, fmt.Sprintf("capbset_drop %d", c))
	}
	return append(seq, "ambient_clear", "capset_zero", "no_new_privs")
}

func run(t *testing.T, f *fakeSys, args ...string) (int, string) {
	t.Helper()
	var out, errb bytes.Buffer
	code := runMain(args, f, &out, &errb)
	return code, errb.String()
}

func has(calls []string, prefix string) bool {
	for _, c := range calls {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}

func index(calls []string, prefix string) int {
	for i, c := range calls {
		if strings.HasPrefix(c, prefix) {
			return i
		}
	}
	return -1
}

// (a) uid 0 and gid 0 are refused; slot parsing is strict.

func TestCheckIDsRefusesZero(t *testing.T) {
	for _, c := range [][2]int{{0, 1001}, {1001, 0}, {0, 0}} {
		if err := checkIDs(c[0], c[1]); err == nil {
			t.Errorf("checkIDs(%d, %d) accepted", c[0], c[1])
		}
	}
	if err := checkGroup(0); err == nil {
		t.Error("checkGroup(0) accepted")
	}
	if err := checkIDs(1001, 1001); err != nil {
		t.Errorf("checkIDs(1001, 1001): %v", err)
	}
}

func TestParseSlotRefusesJunk(t *testing.T) {
	for _, s := range []string{"-1", "256", "1e3", " 1", "1 ", "+1", "", "01x", "01", "00",
		"0x1", "1.0", "999", "4294967297", "18446744073709551617", "99999999999999999999999999"} {
		if n, err := parseSlot(s); err == nil {
			t.Errorf("parseSlot(%q) = %d, want error", s, n)
		}
	}
	for _, c := range []struct {
		s string
		n int
	}{{"0", 0}, {"7", 7}, {"255", 255}} {
		if n, err := parseSlot(c.s); err != nil || n != c.n {
			t.Errorf("parseSlot(%q) = %d, %v", c.s, n, err)
		}
	}
}

// (b) only the compiled range is reachable.

func TestSlotsMapOnlyIntoRange(t *testing.T) {
	seen := map[int]bool{}
	for s := 0; s < slots; s++ {
		id, err := slotID(s)
		if err != nil {
			t.Fatalf("slotID(%d): %v", s, err)
		}
		if id < 1001 || id > 1256 || seen[id] {
			t.Fatalf("slotID(%d) = %d", s, id)
		}
		seen[id] = true
		n, err := parseSlot(fmt.Sprint(s))
		if err != nil || n != s {
			t.Fatalf("parseSlot(%d) = %d, %v", s, n, err)
		}
	}
	for s := slots; s < 1000; s++ {
		if _, err := parseSlot(fmt.Sprint(s)); err == nil {
			t.Fatalf("parseSlot(%d) accepted", s)
		}
	}
	for _, s := range []int{-1, slots, 1 << 20} {
		if _, err := slotID(s); err == nil {
			t.Errorf("slotID(%d) accepted", s)
		}
	}
	for _, id := range []int{1000, 1257, 65534} {
		if err := checkIDs(id, id); err == nil {
			t.Errorf("checkIDs(%d) accepted", id)
		}
	}
	for _, g := range []int{999, 1000, 1257, 65534} {
		if err := checkGroup(g); err == nil {
			t.Errorf("checkGroup(%d) accepted", g)
		}
	}
}

func TestOutOfRangeSlotsTouchNothing(t *testing.T) {
	cases := [][]string{
		{"run", "256", "--", "/bin/true"},
		{"run", "-1", "--", "/bin/true"},
		{"reap", "256"},
		{"reap", "1e3", "--sweep", "/tmp"},
		{"own", "256", "/tmp/x"},
		{"own", "-1", "/tmp/x"},
		{"own", "runners", "/tmp/x"},
		{"own", "3", "tmp/x"},
		{"own", "runner", "/tmp/x", "x"},
	}
	for _, args := range cases {
		f := newFake(40)
		code, stderr := run(t, f, args...)
		if code != exitRefused || len(f.calls) != 0 {
			t.Errorf("%v: code %d calls %v stderr %q", args, code, f.calls, stderr)
		}
	}
}

func TestEveryRunSlotSetsOnlyItsID(t *testing.T) {
	for s := 0; s < slots; s++ {
		f := newFake(2)
		code, stderr := run(t, f, "run", fmt.Sprint(s), "--", "/bin/true")
		if code != 0 {
			t.Fatalf("slot %d: code %d %s", s, code, stderr)
		}
		id := firstID + s
		if f.uid != id || f.gid != id || fmt.Sprint(f.groups) != fmt.Sprint([]int{id}) {
			t.Fatalf("slot %d: uid %d gid %d groups %v", s, f.uid, f.gid, f.groups)
		}
	}
}

func TestReapIDsComeFromSlots(t *testing.T) {
	f := newFake(1)
	if code, stderr := run(t, f, "reap", "9", "--sweep", "/tmp"); code != 0 {
		t.Fatalf("reap: %d %s", code, stderr)
	}
	want := dropSeq(1010, []int{1010}, 1)
	if got := f.calls[:len(want)]; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("reap calls %v, want prefix %v", f.calls, want)
	}
	// The reap never takes the runner's group, and no longer takes --fix.
	f = newFake(1)
	if code, _ := run(t, f, "reap", "9", "--fix", "/tmp"); code != exitUsage || len(f.calls) != 0 {
		t.Errorf("reap --fix: code %d calls %v", code, f.calls)
	}
}

// own: keeps CAP_CHOWN alone, checks it, then gives each DIR; a slot's uid
// comes from the slot, the runner's from the helper's real uid.

func TestOwnSequence(t *testing.T) {
	f := newFake(40)
	code, stderr := run(t, f, "own", "4", "/data/a", "/data/b")
	if code != 0 || stderr != "" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	want := []string{"capset_only 0x1", "read_status", "own /data/a runner=1000 uid=1005 gid=1000", "own /data/b runner=1000 uid=1005 gid=1000"}
	if fmt.Sprint(f.calls) != fmt.Sprint(want) {
		t.Fatalf("calls\n got %v\nwant %v", f.calls, want)
	}
	for uid, want := range map[int]bool{0: false, 999: false, 1000: true, 1001: true, 1256: true, 1257: false, 65534: false} {
		if f.owners(uid) != want {
			t.Errorf("owned(%d) = %v, want %v", uid, !want, want)
		}
	}
	f = newFake(40)
	if code, stderr := run(t, f, "own", "runner", "/data/a"); code != 0 || fmt.Sprint(f.calls) != fmt.Sprint([]string{"capset_only 0x1", "read_status", "own /data/a runner=1000 uid=1000 gid=1000"}) {
		t.Fatalf("own runner: code %d stderr %q calls %v", code, stderr, f.calls)
	}
}

func TestOwnRefusesRootOrASlotAsTheRunner(t *testing.T) {
	for _, uid := range []int{0, 1001, 1256} {
		f := newFake(40)
		f.realUID, f.root = uid, uid == 0
		if code, stderr := run(t, f, "own", "runner", "/data/a"); code != exitRefused || len(f.calls) != 0 {
			t.Errorf("uid %d: code %d calls %v stderr %q", uid, code, f.calls, stderr)
		}
	}
}

func TestOwnGivesNothingAfterAFailedNarrowing(t *testing.T) {
	for _, step := range []string{"capset_only", "read_status"} {
		f := newFake(40)
		f.failAt = step
		if code, _ := run(t, f, "own", "2", "/data/a"); code != exitRefused || has(f.calls, "own") {
			t.Errorf("fail at %s: code %d calls %v", step, code, f.calls)
		}
	}
	// A status that still shows another capability is refused too.
	f := newFake(40)
	f.status = func(*fakeSys) string { return sampleStatus(1000, 1000, "1000", "00000000000000c1", 0) }
	if code, _ := run(t, f, "own", "2", "/data/a"); code != exitRefused || has(f.calls, "own") {
		t.Errorf("verify: code %d calls %v", code, f.calls)
	}
}

func TestOwnSaysWhenADirWasNotGiven(t *testing.T) {
	f := newFake(40)
	f.failAt = "own /data/b runner=1000 uid=1003 gid=1000"
	if code, _ := run(t, f, "own", "2", "/data/a", "/data/b", "/data/c"); code != 1 || !has(f.calls, "own /data/c") {
		t.Errorf("code %d calls %v", code, f.calls)
	}
}

// (c) the run and reap sequences, and fail-closed on every step.

func TestRunSequence(t *testing.T) {
	f := newFake(40)
	f.fds = []int{0, 1, 2, 3, 4, 7, 9}
	code, stderr := run(t, f, "run", "0", "--keep-fd", "4", "--keep-fd", "9", "--", "/bin/true", "-x")
	if code != 0 {
		t.Fatalf("code %d: %s", code, stderr)
	}
	want := []string{"getppid", "list_fds", "close_fd 3", "close_fd 7"}
	want = append(want, dropSeq(1001, []int{1001}, 40)...)
	want = append(want, "pdeathsig", "getppid", "umask 07", "read_status", "exec /bin/true [/bin/true -x]")
	if fmt.Sprint(f.calls) != fmt.Sprint(want) {
		t.Fatalf("calls\n got %v\nwant %v", f.calls, want)
	}
}

func TestRunNeverExecsAfterAFailedStep(t *testing.T) {
	steps := []string{"list_fds", "close_fd", "setgroups", "setresgid", "setresuid", "cap_last_cap",
		"capbset_drop", "capbset_drop 0", "capbset_drop 17", "capbset_drop 40",
		"ambient_clear", "capset_zero", "no_new_privs", "pdeathsig", "read_status"}
	for _, step := range steps {
		f := newFake(40)
		f.fds = []int{0, 1, 2, 5}
		f.failAt = step
		code, stderr := run(t, f, "run", "0", "--", "/bin/true")
		if code != exitRefused || has(f.calls, "exec") || !strings.HasPrefix(stderr, "agentrun-runas: ") {
			t.Errorf("fail at %s: code %d exec %v stderr %q", step, code, has(f.calls, "exec"), stderr)
		}
	}

	// the parent died: the second getppid differs
	f := newFake(40)
	f.ppids = []int{4242, 1}
	if code, stderr := run(t, f, "run", "0", "--", "/bin/true"); code != exitRefused || has(f.calls, "exec") ||
		!strings.Contains(stderr, "parent exited") {
		t.Errorf("parent died: code %d stderr %q", code, stderr)
	}

	// the verifier refuses what the kernel shows
	f = newFake(40)
	f.status = func(f *fakeSys) string { return strings.Replace(statusFor(f), "NoNewPrivs:\t1", "NoNewPrivs:\t0", 1) }
	if code, stderr := run(t, f, "run", "0", "--", "/bin/true"); code != exitRefused || has(f.calls, "exec") ||
		!strings.Contains(stderr, "status check") {
		t.Errorf("verify: code %d stderr %q", code, stderr)
	}

	// exec itself fails
	f = newFake(40)
	f.failAt = "exec"
	if code, _ := run(t, f, "run", "0", "--", "/bin/true"); code != exitRefused {
		t.Errorf("exec failure: code %d", code)
	}
}

func TestRunRefusesBadArguments(t *testing.T) {
	for _, c := range []struct {
		args []string
		code int
	}{
		{[]string{"run", "0", "--", "true"}, exitRefused},
		{[]string{"run", "0", "--keep-fd", "2", "--", "/bin/true"}, exitRefused},
		{[]string{"run", "0", "--keep-fd", "x", "--", "/bin/true"}, exitRefused},
		{[]string{"run", "0", "/bin/true"}, exitUsage},
		{[]string{"run", "0", "--"}, exitUsage},
		{[]string{"run"}, exitUsage},
		{[]string{"nope"}, exitUsage},
		{[]string{}, exitUsage},
		{[]string{"check", "x"}, exitUsage},
		{[]string{"reap", "0", "--sweep"}, exitUsage},
		{[]string{"reap", "0", "--sweep", "tmp"}, exitRefused},
		{[]string{"reown", "0", "1", "/x"}, exitUsage},
		{[]string{"own", "0"}, exitUsage},
		{[]string{"own"}, exitUsage},
	} {
		f := newFake(40)
		code, stderr := run(t, f, c.args...)
		if code != c.code || has(f.calls, "exec") || has(f.calls, "setgroups") {
			t.Errorf("%v: code %d calls %v stderr %q", c.args, code, f.calls, stderr)
		}
		if !strings.HasPrefix(stderr, "agentrun-runas: ") || strings.Count(stderr, "\n") != 1 {
			t.Errorf("%v: stderr %q", c.args, stderr)
		}
	}
}

func TestReapSequence(t *testing.T) {
	f := newFake(3)
	f.kills = []error{nil, nil}
	f.live = []int{2, 0}
	code, stderr := run(t, f, "reap", "2")
	if code != 0 || stderr != "" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	want := dropSeq(1003, []int{1003}, 3)
	want = append(want, "read_status", "kill -1 9", "live_procs 1003", "sleep", "kill -1 9", "live_procs 1003")
	if fmt.Sprint(f.calls) != fmt.Sprint(want) {
		t.Fatalf("calls\n got %v\nwant %v", f.calls, want)
	}
}

func TestReapEndsOnESRCH(t *testing.T) {
	f := newFake(0)
	f.kills = []error{nil, syscall.ESRCH}
	f.live = []int{1}
	if code, stderr := run(t, f, "reap", "0"); code != 0 {
		t.Fatalf("code %d %s", code, stderr)
	}
	if n := strings.Count(fmt.Sprint(f.calls), "kill"); n != 2 {
		t.Errorf("kills %d, calls %v", n, f.calls)
	}
}

func TestReapGivesUpAfterBoundedTries(t *testing.T) {
	f := newFake(0)
	for i := 0; i < killTries+5; i++ {
		f.kills = append(f.kills, nil)
	}
	code, stderr := run(t, f, "reap", "0")
	if code != 1 || !strings.Contains(stderr, "still alive") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if n := strings.Count(fmt.Sprint(f.calls), "kill -1"); n != killTries {
		t.Errorf("kills %d, want %d", n, killTries)
	}
}

func TestReapNeverKillsAfterAFailedDrop(t *testing.T) {
	steps := []string{"setgroups", "setresgid", "setresuid", "cap_last_cap", "capbset_drop",
		"capbset_drop 5", "ambient_clear", "capset_zero", "no_new_privs", "read_status"}
	for _, step := range steps {
		for _, args := range [][]string{{"reap", "0"}} {
			f := newFake(5)
			f.failAt = step
			code, stderr := run(t, f, args...)
			if code != exitRefused || has(f.calls, "kill") || !strings.HasPrefix(stderr, "agentrun-runas: ") {
				t.Errorf("%v fail at %s: code %d calls %v", args, step, code, f.calls)
			}
		}
	}
	f := newFake(5)
	f.status = func(f *fakeSys) string {
		return strings.Replace(statusFor(f), "CapBnd:\t0000000000000000", "CapBnd:\t0000000000000080", 1)
	}
	if code, _ := run(t, f, "reap", "0"); code != exitRefused || has(f.calls, "kill") {
		t.Errorf("verify: code %d calls %v", code, f.calls)
	}
}

// (d) no_new_privs is set and every capability set is empty at exec.

func TestNoNewPrivsBeforeExec(t *testing.T) {
	f := newFake(40)
	if code, stderr := run(t, f, "run", "5", "--", "/bin/true"); code != 0 {
		t.Fatalf("code %d %s", code, stderr)
	}
	if i, e := index(f.calls, "no_new_privs"), index(f.calls, "exec"); i < 0 || i > e {
		t.Fatalf("no_new_privs at %d, exec at %d", i, e)
	}
	if !strings.Contains(f.execState, "nnp=true") {
		t.Fatalf("exec state %s", f.execState)
	}
}

func TestCapsZeroBeforeExec(t *testing.T) {
	f := newFake(40)
	if code, stderr := run(t, f, "run", "5", "--", "/bin/true"); code != 0 {
		t.Fatalf("code %d %s", code, stderr)
	}
	e := index(f.calls, "exec")
	for _, step := range []string{"capbset_drop 40", "ambient_clear", "capset_zero"} {
		if i := index(f.calls, step); i < 0 || i > e {
			t.Fatalf("%s at %d, exec at %d", step, i, e)
		}
	}
	if !strings.Contains(f.execState, "capsZero=true") || !strings.Contains(f.execState, "uid=1006 gid=1006 groups=[1006]") {
		t.Fatalf("exec state %s", f.execState)
	}
	// with caps left the verifier stops it
	f = newFake(40)
	f.status = func(f *fakeSys) string {
		f.capsZero = false
		return statusFor(f)
	}
	if code, _ := run(t, f, "run", "5", "--", "/bin/true"); code != exitRefused || has(f.calls, "exec") {
		t.Fatalf("caps left: code %d calls %v", code, f.calls)
	}
}

// (e) the /proc/self/status verifier.

func TestVerifyStatus(t *testing.T) {
	zero := "0000000000000000"
	good := sampleStatus(1001, 1001, "1001", zero, 1)
	if err := verifyStatus(good, 1001, []int{1001}); err != nil {
		t.Fatalf("good sample refused: %v", err)
	}
	bad := map[string]string{
		"saved uid 1000":   strings.Replace(good, "Uid:\t1001\t1001\t1001\t1001", "Uid:\t1001\t1001\t1000\t1001", 1),
		"fs gid 1000":      strings.Replace(good, "Gid:\t1001\t1001\t1001\t1001", "Gid:\t1001\t1001\t1001\t1000", 1),
		"groups 1000 1001": strings.Replace(good, "Groups:\t1001 ", "Groups:\t1000 1001 ", 1),
		"groups empty":     strings.Replace(good, "Groups:\t1001 ", "Groups:\t", 1),
		"CapBnd":           strings.Replace(good, "CapBnd:\t"+zero, "CapBnd:\t0000000000000001", 1),
		"CapAmb":           strings.Replace(good, "CapAmb:\t"+zero, "CapAmb:\t0000000000000080", 1),
		"CapInh":           strings.Replace(good, "CapInh:\t"+zero, "CapInh:\t0000000000000040", 1),
		"CapPrm":           strings.Replace(good, "CapPrm:\t"+zero, "CapPrm:\t0000000000000100", 1),
		"CapEff":           strings.Replace(good, "CapEff:\t"+zero, "CapEff:\t8000000000000000", 1),
		"NoNewPrivs 0":     strings.Replace(good, "NoNewPrivs:\t1", "NoNewPrivs:\t0", 1),
		"no NoNewPrivs":    strings.Replace(good, "NoNewPrivs:\t1\n", "", 1),
		"no CapAmb":        strings.Replace(good, "CapAmb:\t"+zero+"\n", "", 1),
		"uid 0":            sampleStatus(0, 1001, "1001", zero, 1),
		"three uid fields": strings.Replace(good, "Uid:\t1001\t1001\t1001\t1001", "Uid:\t1001\t1001\t1001", 1),
		"twice":            good + "Uid:\t1001\t1001\t1001\t1001\n",
	}
	for name, text := range bad {
		if text == good {
			t.Fatalf("%s: sample did not change", name)
		}
		if err := verifyStatus(text, 1001, []int{1001}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	two := sampleStatus(1001, 1001, "1000 1001", zero, 1)
	if err := verifyStatus(two, 1001, []int{1001, 1000}); err != nil {
		t.Errorf("two groups refused: %v", err)
	}
}

func TestMissingCaps(t *testing.T) {
	all := sampleStatus(1000, 1000, "1000", "00000000000001c1", 0)
	if m, err := missingCaps(all); err != nil || len(m) != 0 {
		t.Errorf("all held: %v %v", m, err)
	}
	none := sampleStatus(1000, 1000, "1000", "0000000000000000", 0)
	if m, _ := missingCaps(none); strings.Join(m, ",") != "CAP_CHOWN,CAP_SETUID,CAP_SETGID,CAP_SETPCAP" {
		t.Errorf("none held: %v", m)
	}
	f := newFake(0)
	f.status = func(*fakeSys) string { return all }
	var out, errb bytes.Buffer
	if code := runMain([]string{"check"}, f, &out, &errb); code != 0 || out.String() != "agentrun-runas: range 1001-1256\n" {
		t.Errorf("check: %d %q %q", code, out.String(), errb.String())
	}
}

func TestProcAlive(t *testing.T) {
	zero := "0000000000000000"
	s := sampleStatus(1001, 1001, "1001", zero, 1)
	if !procAlive(s, 1001) || procAlive(s, 1002) {
		t.Error("running process")
	}
	z := strings.Replace(s, "State:\tR (running)", "State:\tZ (zombie)", 1)
	if procAlive(z, 1001) {
		t.Error("zombie counted")
	}
	saved := strings.Replace(s, "Uid:\t1001\t1001\t1001\t1001", "Uid:\t1000\t1000\t1001\t1000", 1)
	if !procAlive(saved, 1001) {
		t.Error("saved uid missed")
	}
}

// (f) fd selection.

func TestFdsToClose(t *testing.T) {
	got, err := fdsToClose([]int{0, 1, 2, 3, 4, 5, 10, 11, 4}, []int{4, 11, 12})
	if err != nil || fmt.Sprint(got) != "[3 5 10]" {
		t.Fatalf("got %v %v", got, err)
	}
	got, err = fdsToClose([]int{9, 0, 3, 1}, nil)
	if err != nil || fmt.Sprint(got) != "[3 9]" {
		t.Fatalf("got %v %v", got, err)
	}
	for _, k := range []int{0, 1, 2, -1} {
		if _, err := fdsToClose([]int{0, 1, 2, 3}, []int{k}); err == nil {
			t.Errorf("keep %d accepted", k)
		}
	}
}

// (g) fixMode.

func TestFixMode(t *testing.T) {
	for _, c := range []struct {
		mode uint32
		dir  bool
		want uint32
	}{
		{0o644, false, 0o660},
		{0o700, true, 0o2770},
		{0o604, false, 0o660},
		{0o755, false, 0o770},
		{0o4755, false, 0o770},
		{0o1777, true, 0o2770},
		{0o2750, true, 0o2770},
		{0o000, true, 0o2770},
		{0o500, true, 0o2770},
		{0o000, false, 0o000},
	} {
		if got := fixMode(c.mode, c.dir); got != c.want {
			t.Errorf("fixMode(%#o, %v) = %#o, want %#o", c.mode, c.dir, got, c.want)
		}
	}
}

// sweep and fix on files this test owns.

func TestSweepRemovesOwnedAndKeepsLinkTargets(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "tmp")
	outside := filepath.Join(root, "outside")
	must(t, os.MkdirAll(filepath.Join(dir, "locked", "inner"), 0o755))
	must(t, os.WriteFile(filepath.Join(dir, "locked", "inner", "f"), []byte("x"), 0o644))
	must(t, os.WriteFile(filepath.Join(dir, "plain"), []byte("x"), 0o644))
	must(t, os.MkdirAll(outside, 0o755))
	must(t, os.WriteFile(filepath.Join(outside, "keep"), []byte("x"), 0o644))
	must(t, os.Symlink(outside, filepath.Join(dir, "link")))
	must(t, os.Chmod(filepath.Join(dir, "locked", "inner"), 0o000))
	must(t, os.Chmod(filepath.Join(dir, "locked"), 0o500))

	var errb bytes.Buffer
	if !sweepDir(dir, os.Getuid(), &errb) {
		t.Fatalf("sweep failed: %s", errb.String())
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 0 {
		t.Errorf("left %v", ents)
	}
	if _, err := os.Stat(filepath.Join(outside, "keep")); err != nil {
		t.Errorf("link target gone: %v", err)
	}
	if !sweepDir(filepath.Join(root, "missing"), os.Getuid(), &errb) {
		t.Error("missing dir failed")
	}
	// another uid's entries stay
	must(t, os.WriteFile(filepath.Join(dir, "mine"), []byte("x"), 0o644))
	if !sweepDir(dir, os.Getuid()+1, &errb) {
		t.Fatal("sweep of nothing failed")
	}
	if _, err := os.Stat(filepath.Join(dir, "mine")); err != nil {
		t.Errorf("other uid's entry removed")
	}
}

func TestOwnDirFixesModesThroughTheTreeAndSkipsLinksAndOthers(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "work")
	outside := filepath.Join(root, "outside")
	must(t, os.MkdirAll(filepath.Join(dir, "sub", "deep"), 0o755))
	must(t, os.WriteFile(filepath.Join(dir, "sub", "deep", "f"), []byte("x"), 0o600))
	must(t, os.WriteFile(outside, []byte("x"), 0o604))
	must(t, os.Chmod(outside, 0o604))
	must(t, os.Symlink(outside, filepath.Join(dir, "link")))
	// A folder its writer shut (0o000) is opened up to the runner's group.
	must(t, os.Chmod(filepath.Join(dir, "sub", "deep"), 0o000))
	must(t, os.Chmod(filepath.Join(dir, "sub"), 0o700))

	me, gid := os.Getuid(), os.Getgid()
	var errb bytes.Buffer
	if !ownDir(dir, func(uid int) bool { return uid == me }, me, me, gid, &errb) {
		t.Fatalf("own failed: %s", errb.String())
	}
	checkMode(t, dir, 0o2770)
	checkMode(t, filepath.Join(dir, "sub"), 0o2770)
	checkMode(t, filepath.Join(dir, "sub", "deep"), 0o2770)
	checkMode(t, filepath.Join(dir, "sub", "deep", "f"), 0o660)
	checkMode(t, outside, 0o604)
	if !ownDir(filepath.Join(root, "missing"), func(int) bool { return true }, me, me, gid, &errb) {
		t.Error("a missing dir failed")
	}
	// An entry of a uid owned() refuses is left as it is, and so is all below it.
	must(t, os.Chmod(filepath.Join(dir, "sub", "deep", "f"), 0o644))
	must(t, os.Chmod(filepath.Join(dir, "sub"), 0o755))
	if !ownDir(dir, func(int) bool { return false }, me, me, gid, &errb) {
		t.Fatal("own of nothing failed")
	}
	checkMode(t, filepath.Join(dir, "sub"), 0o755)
	checkMode(t, filepath.Join(dir, "sub", "deep", "f"), 0o644)
	// A DIR that is itself a symlink is never followed.
	link := filepath.Join(root, "dirlink")
	must(t, os.Symlink(dir, link))
	if !ownDir(link, func(uid int) bool { return uid == me }, me, me, gid, &errb) {
		t.Fatalf("own of a link failed: %s", errb.String())
	}
	checkMode(t, filepath.Join(dir, "sub"), 0o755)
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func checkMode(t *testing.T, p string, want uint32) {
	t.Helper()
	var st syscall.Stat_t
	must(t, syscall.Lstat(p, &st))
	if got := st.Mode & 0o7777; got != want {
		t.Errorf("%s mode %#o, want %#o", p, got, want)
	}
}
