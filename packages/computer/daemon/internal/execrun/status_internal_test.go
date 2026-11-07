package execrun

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// The status stream has no total limit: a guard that answered many group signals (more than 64 KiB of answers) still
// has its final status read. Each line alone is bounded.
func TestManyGroupAnswersDoNotStopTheStatusStream(t *testing.T) {
	statusReader, status, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	stand := exec.Command("/bin/sleep", "0.2")
	if err := stand.Start(); err != nil {
		t.Fatal(err)
	}
	g := &Guarded{guard: stand, done: make(chan struct{})}
	started := make(chan struct{})
	go g.follow(statusReader, started)
	go func() {
		enc := json.NewEncoder(status)
		_ = enc.Encode(guardStatus{Pid: 4242})
		reason := fmt.Sprintf("%0200d", 0)
		for seq := uint64(1); seq <= 2000; seq++ {
			_ = enc.Encode(guardStatus{Signalled: &groupSignalled{Seq: seq, Group: 4243, Sent: false, Reason: reason}})
		}
		code := 7
		_ = enc.Encode(guardStatus{ExitCode: &code})
		_ = status.Close()
	}()
	select {
	case <-g.Done():
	case <-time.After(20 * time.Second):
		t.Fatal("follow did not end")
	}
	code, _, reported := g.Exit()
	if !reported || code == nil || *code != 7 {
		t.Fatalf("after 2000 group answers (over 64 KiB), the final status: reported %v, code %v; want reported, 7", reported, code)
	}
}

// A pipeline whose leader is reaped: a member that exits between being found and being asked its session does not
// end the search; a later member still in the program's session answers it.
func TestInSessionLooksPastAMemberThatVanished(t *testing.T) {
	const group, session = 500, 400
	pgid := func(pid int) (int, error) { return group, nil }
	sid := func(pid int) (int, error) {
		if pid == 501 {
			return 0, syscall.ESRCH
		}
		return session, nil
	}
	if !inSessionAmong(group, session, []int{501, 502}, pgid, sid) {
		t.Fatal("member 501 vanished, member 502 is in the program's session: want in session")
	}
	if inSessionAmong(group, session, []int{501}, pgid, sid) {
		t.Fatal("the only member vanished: want not in session")
	}
	other := func(pid int) (int, error) { return 999, nil }
	if inSessionAmong(group, session, []int{502}, pgid, other) {
		t.Fatal("a member in another session: want not in session")
	}
}
