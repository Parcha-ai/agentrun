// Copyright 2026 The Kubernetes Authors.
// Copyright 2023 FoundryLabs, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// From kubernetes-sigs/agent-sandbox@bfc8505 packages/sandboxd/pkg/processmanager (ProcessRegistry, ManagedProcess:
// Signal, CloseStdin, ResizeTTY) and pkg/server/process.go (WriteStdin, SendSignal, ResizeTTY), and e2b-dev/infra@ff3922213f02
// packages/envd/internal/services/process (signal.go's signal names, list.go, and handler.go's pty read loop, which
// ends on EIO). Changed for the open platform: ids are "p1", "p2", ...; the table is bounded and keeps ended
// processes for reads; output goes to a ring per stream read by offset, not to subscribers; a signal goes to the
// program's group through its guard, INT on a terminal to its foreground group; errors are the protocol's kinds.

package process

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// writeTimeout bounds one process.write when the program does not read.
const writeTimeout = 10 * time.Second

const maxWaitTimeoutMs = 24 * 60 * 60 * 1000

const (
	// maxListBytes keeps a process.list reply, in JSON, well inside a line.
	maxListBytes = 768 << 10
	// maxListedArgv is the most of one argv, in JSON, a listing holds, so every entry fits a page.
	maxListedArgv = 64 << 10
)

var signals = map[string]syscall.Signal{"TERM": syscall.SIGTERM, "INT": syscall.SIGINT, "KILL": syscall.SIGKILL, "HUP": syscall.SIGHUP}

// Table is every process the daemon holds, shared by all its connections. It holds at most MaxEntries, running or
// ended; a start into a full table drops the process that ended first once the new one runs, and is refused as limit
// when all of them run. Its rings, live and ended, hold at most RetainedBytes together: past that, the rings of the
// processes that ended first are let go, while their entries stay, and when no ended ring is left the live rings are
// limited to their share of the budget.
type Table struct {
	opts Options
	// startSlot holds one token while a start runs; a start waits for it in a select, so its cancellation ends the wait.
	startSlot chan struct{}
	mu        sync.Mutex
	// procs is in start order, which is seq order.
	procs   []*proc
	lastSeq int64
	// held is what every ring's buffer holds, in bytes.
	held int64
}

func NewTable(opts Options) *Table {
	if opts.RingBytes <= 0 {
		opts.RingBytes = RingBytes
	}
	if opts.MaxEntries <= 0 {
		opts.MaxEntries = MaxEntries
	}
	if opts.RetainedBytes <= 0 {
		opts.RetainedBytes = RetainedBytes
	}
	if opts.LogBytes <= 0 {
		opts.LogBytes = LogBytes
	}
	return &Table{opts: opts, startSlot: make(chan struct{}, 1)}
}

type proc struct {
	table *Table
	id    string
	// seq is the number in id: 1 for the table's first start, and up by one for each start since.
	seq     int64
	pid     int
	argv    []string
	pty     bool
	started time.Time
	g       *execrun.Guarded

	// writing is a lock on input, held by one write at a time; a channel so that a write can stop waiting for it.
	writing chan struct{}
	// input is stdin or the terminal; nil when the process takes none, or no longer does.
	input     *os.File
	takesNone bool

	// log is the file the first output goes to, when the start named one; nil otherwise.
	log *logFile

	mu       sync.Mutex
	terminal *os.File
	streams  map[string]*stream
	changed  chan struct{}
	ended    chan struct{}
	exitCode *int
	signal   string
	endedAt  time.Time
}

type stream struct {
	ring
	reader *os.File
	eof    bool
}

// notify wakes every read and wait parked on p. Hold p.mu.
func (p *proc) notify() {
	close(p.changed)
	p.changed = make(chan struct{})
}

func (p *proc) lockInput()   { p.writing <- struct{}{} }
func (p *proc) unlockInput() { <-p.writing }

func (p *proc) hasEnded() bool {
	select {
	case <-p.ended:
		return true
	default:
		return false
	}
}

func (t *Table) Start(ctx context.Context, params StartParams) (StartResult, error) {
	if params.Pty != nil {
		if err := checkSize(*params.Pty); err != nil {
			return StartResult{}, err
		}
	}
	select {
	case t.startSlot <- struct{}{}:
	case <-ctx.Done():
		return StartResult{}, rpc.Errorf(rpc.KindAborted, "process.start was cancelled while another start was in progress")
	}
	defer func() { <-t.startSlot }()
	if params.Orphans != "" && params.Orphans != "keep" {
		return StartResult{}, rpc.Errorf(rpc.KindInvalid, `orphans is "keep" or absent, not %q`, params.Orphans)
	}
	if err := t.checkRoom(); err != nil {
		return StartResult{}, err
	}
	p := &proc{table: t, argv: params.Argv, pty: params.Pty != nil, writing: make(chan struct{}, 1), streams: map[string]*stream{}, changed: make(chan struct{}), ended: make(chan struct{})}
	if params.Log != "" {
		log, err := openLog(params.Log, t.opts.LogBytes)
		if err != nil {
			return StartResult{}, err
		}
		p.log = log
		// A start that does not run its program leaves no log behind.
		defer func() {
			if p.g == nil {
				log.discard()
			}
		}()
	}
	var stdin, stdout, stderr *os.File
	var theirs []*os.File
	if params.Pty != nil {
		master, slave, err := openPty(*params.Pty)
		if err != nil {
			return StartResult{}, rpc.Errorf(rpc.KindUnsupported, "%v", err)
		}
		stdin, stdout, stderr = slave, slave, slave
		theirs = []*os.File{slave}
		p.input, p.terminal = master, master
		p.streams["pty"] = &stream{ring: ring{size: t.opts.RingBytes}, reader: master}
	} else {
		for _, name := range []string{"stdout", "stderr"} {
			r, w, err := os.Pipe()
			if err != nil {
				closeAll(theirs...)
				p.release()
				return StartResult{}, fmt.Errorf("cannot make a pipe: %w", err)
			}
			p.streams[name] = &stream{ring: ring{size: t.opts.RingBytes}, reader: r}
			theirs = append(theirs, w)
		}
		stdout, stderr = theirs[0], theirs[1]
		p.takesNone = !params.Stdin
		if params.Stdin {
			r, w, err := os.Pipe()
			if err != nil {
				closeAll(theirs...)
				p.release()
				return StartResult{}, fmt.Errorf("cannot make a pipe: %w", err)
			}
			stdin, p.input = r, w
			theirs = append(theirs, r)
		}
	}
	g, err := execrun.Start(ctx, execrun.Program{Argv: params.Argv, Cwd: params.Cwd, Env: params.Env, User: params.User, Terminal: p.pty, WaitGroup: params.WaitGroup, KeepOrphans: params.Orphans == "keep"}, stdin, stdout, stderr)
	closeAll(theirs...)
	if err != nil {
		p.release()
		return StartResult{}, err
	}
	if p.log != nil {
		p.log.settle()
	}
	t.mu.Lock()
	dropped := t.dropOldestEnded()
	t.lastSeq++
	p.seq, p.pid, p.g, p.started = t.lastSeq, g.Pid, g, time.Now()
	p.id = "p" + strconv.FormatInt(p.seq, 10)
	t.procs = append(t.procs, p)
	t.mu.Unlock()
	if dropped != nil {
		dropped.release()
	}
	for _, s := range p.streams {
		go p.collect(s)
	}
	go p.watch()
	return StartResult{ID: p.id, Pid: p.pid}, nil
}

// checkRoom refuses a start into a full table whose every process runs. It drops nothing: a start drops an ended
// process only once its own program runs. Hold the start slot, so that no start fills the room between the two.
func (t *Table) checkRoom() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.procs) < t.opts.MaxEntries || t.oldestEnded() >= 0 {
		return nil
	}
	return rpc.Errorf(rpc.KindLimit, "%d processes are running, the most this daemon holds: end one first", len(t.procs))
}

// oldestEnded is the index of the process that ended first, or -1 when every one runs. Hold t.mu.
func (t *Table) oldestEnded() int {
	oldest := -1
	for i, p := range t.procs {
		p.mu.Lock()
		if p.hasEnded() && (oldest < 0 || p.endedAt.Before(t.procs[oldest].endedAt)) {
			oldest = i
		}
		p.mu.Unlock()
	}
	return oldest
}

// dropOldestEnded takes the process that ended first out of a full table, for the caller to release once it has let
// go of t.mu. Hold t.mu and the start slot, after checkRoom: a process that has ended never runs again, so there is one.
func (t *Table) dropOldestEnded() *proc {
	if len(t.procs) < t.opts.MaxEntries {
		return nil
	}
	oldest := t.oldestEnded()
	p := t.procs[oldest]
	t.procs = append(t.procs[:oldest], t.procs[oldest+1:]...)
	t.held -= p.releaseRings()
	return p
}

// hold counts grew more bytes in a ring, then keeps the table within its budget. Hold no proc's mu.
func (t *Table) hold(grew int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.held += int64(grew)
	t.trim()
}

// trim keeps the table within RetainedBytes. First it lets go of the rings of the processes that ended first. When
// every ended ring is gone and the table is still over, the live rings are what holds it: each stops growing and keeps
// at most an equal share of the budget, never less than the floor, dropping its oldest bytes, which a read reports as
// dropped. Hold t.mu.
func (t *Table) trim() {
	if t.held <= t.opts.RetainedBytes {
		return
	}
	var ended, live []*proc
	rings := 0
	for _, p := range t.procs {
		if p.hasEnded() {
			ended = append(ended, p)
		} else {
			live = append(live, p)
			rings += len(p.streams)
		}
	}
	sort.SliceStable(ended, func(i, j int) bool { return ended[i].endedAt.Before(ended[j].endedAt) })
	for _, p := range ended {
		if t.held <= t.opts.RetainedBytes {
			return
		}
		t.held -= p.releaseRings()
	}
	if t.held <= t.opts.RetainedBytes || rings == 0 {
		return
	}
	share := int(max(t.opts.RetainedBytes/int64(rings), int64(min(RingFloorBytes, t.opts.RingBytes))))
	for _, p := range live {
		t.held -= p.limitRings(share)
	}
}

// limitRings keeps each ring of p within n bytes from now on (ring.limit), and returns how many bytes they let go.
func (p *proc) limitRings(n int) int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	var freed int64
	for _, s := range p.streams {
		freed += int64(s.limit(n))
	}
	return freed
}

// releaseRings lets go of every ring of p, so none of them grows again, and returns how many bytes they held.
func (p *proc) releaseRings() int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	var freed int64
	for _, s := range p.streams {
		freed += int64(s.release())
	}
	return freed
}

// collect reads one stream into its ring until the stream ends: every writer closed it, or (for a terminal) EIO.
func (p *proc) collect(s *stream) {
	buf := make([]byte, 32<<10)
	for {
		n, err := s.reader.Read(buf)
		if n > 0 {
			// The log first, so a read the notify below wakes finds the bytes in it too.
			if p.log != nil {
				p.log.write(buf[:n])
			}
			// Under t.mu, so the table counts and trims the bytes before anything else reads what it holds.
			t := p.table
			t.mu.Lock()
			p.mu.Lock()
			grew := s.write(buf[:n])
			p.notify()
			p.mu.Unlock()
			t.held += int64(grew)
			t.trim()
			t.mu.Unlock()
		}
		if err != nil {
			break
		}
	}
	p.lockInput()
	p.mu.Lock()
	_ = s.reader.Close()
	if p.pty {
		p.input, p.terminal = nil, nil
	}
	s.eof = true
	p.notify()
	p.mu.Unlock()
	p.unlockInput()
}

// watch records how the process ended once its guard says so, and closes its stdin. A guard that keeps what the process
// left outside it runs on after that: it is let go of only once it is done, so the daemon's hold on it never ends them.
func (p *proc) watch() {
	<-p.g.Ended()
	code, signal, _ := p.g.Exit()
	go func() {
		<-p.g.Done()
		p.g.Close()
	}()
	p.lockInput()
	if !p.pty && p.input != nil {
		_ = p.input.Close()
		p.input = nil
	}
	p.unlockInput()
	p.mu.Lock()
	p.exitCode, p.signal, p.endedAt = code, signal, time.Now()
	close(p.ended)
	p.notify()
	p.mu.Unlock()
	p.table.hold(0)
}

// release closes what the daemon holds of a process that is dropped from the table, or never started.
func (p *proc) release() {
	p.lockInput()
	defer p.unlockInput()
	if p.input != nil {
		_ = p.input.Close()
	}
	for _, s := range p.streams {
		_ = s.reader.Close()
	}
	if p.log != nil {
		p.log.close()
	}
}

func (t *Table) get(id string) (*proc, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, p := range t.procs {
		if p.id == id {
			return p, nil
		}
	}
	return nil, rpc.Errorf(rpc.KindNotFound, "no process %q: it never started, or ended and was dropped from the table", id)
}

func (t *Table) Read(ctx context.Context, params ReadParams) (ReadResult, error) {
	p, err := t.get(params.ID)
	if err != nil {
		return ReadResult{}, err
	}
	s := p.streams[params.Stream]
	if s == nil && (params.Stream != "log" || p.log == nil) {
		names := "stdout and stderr"
		if p.pty {
			names = "pty"
		}
		if p.log != nil {
			names += ", and log"
		}
		return ReadResult{}, rpc.Errorf(rpc.KindInvalid, "process %s has no stream %q; it has %s", p.id, params.Stream, names)
	}
	if params.Offset == nil || *params.Offset < 0 {
		return ReadResult{}, rpc.Errorf(rpc.KindInvalid, "offset is required: the bytes since the process started, from 0")
	}
	max := MaxRead
	if params.MaxBytes != nil {
		if max = *params.MaxBytes; max <= 0 {
			return ReadResult{}, rpc.Errorf(rpc.KindInvalid, "maxBytes must be positive")
		}
		if max > MaxRead {
			return ReadResult{}, rpc.Errorf(rpc.KindLimit, "maxBytes %d is over the most one read returns, %d", max, MaxRead)
		}
	}
	if params.WaitMs < 0 || params.WaitMs > MaxWaitMs {
		return ReadResult{}, rpc.Errorf(rpc.KindInvalid, "waitMs is from 0 to %d", MaxWaitMs)
	}
	offset := *params.Offset
	timer := time.NewTimer(time.Duration(params.WaitMs) * time.Millisecond)
	defer timer.Stop()
	waiting := params.WaitMs > 0
	if s == nil {
		return p.readLog(ctx, offset, max, waiting, timer)
	}
	for {
		p.mu.Lock()
		if offset > s.total {
			total := s.total
			p.mu.Unlock()
			return ReadResult{}, rpc.Errorf(rpc.KindInvalid, "offset %d is past the end of %s's %s, %d bytes so far", offset, p.id, params.Stream, total)
		}
		done := s.eof && p.hasEnded()
		if !waiting || offset < s.total || done {
			data, next, dropped := s.read(offset, max)
			res := ReadResult{Data: data, NextOffset: next, Dropped: dropped, Exited: done && next == s.total, Size: s.total}
			p.mu.Unlock()
			return res, nil
		}
		changed := p.changed
		p.mu.Unlock()
		select {
		case <-changed:
		case <-timer.C:
			waiting = false
		case <-ctx.Done():
			return ReadResult{}, rpc.Errorf(rpc.KindAborted, "process.read was cancelled")
		}
	}
}

// readLog is Read of the "log" stream: at most max bytes from offset of the log, read through the daemon's own open
// file. Its size is the bytes the log holds, and it says when output past them was dropped.
func (p *proc) readLog(ctx context.Context, offset int64, max int, waiting bool, timer *time.Timer) (ReadResult, error) {
	for {
		p.mu.Lock()
		done := p.hasEnded()
		for _, s := range p.streams {
			done = done && s.eof
		}
		changed := p.changed
		p.mu.Unlock()
		written, capped, failed := p.log.state()
		if offset > written {
			return ReadResult{}, rpc.Errorf(rpc.KindInvalid, "offset %d is past the end of %s's log, %d bytes so far", offset, p.id, written)
		}
		if !waiting || offset < written || done {
			data := p.log.read(offset, int(min(int64(max), written-offset)))
			next := offset + int64(len(data))
			return ReadResult{Data: data, NextOffset: next, Exited: done && next == written, Size: written, Capped: capped, LogError: failed}, nil
		}
		select {
		case <-changed:
		case <-timer.C:
			waiting = false
		case <-ctx.Done():
			return ReadResult{}, rpc.Errorf(rpc.KindAborted, "process.read was cancelled")
		}
	}
}

func (t *Table) Write(ctx context.Context, params WriteParams) (Empty, error) {
	p, err := t.get(params.ID)
	if err != nil {
		return Empty{}, err
	}
	if p.pty && params.Close {
		return Empty{}, rpc.Errorf(rpc.KindInvalid, `a terminal has no stdin to close: write "\x04" for the end of input, or signal HUP`)
	}
	// The bound counts from here: a write's wait for its turn, behind another write to the same process, is in it.
	by := time.Now().Add(writeTimeout)
	turn := time.NewTimer(writeTimeout)
	defer turn.Stop()
	select {
	case p.writing <- struct{}{}:
	case <-ctx.Done():
		return Empty{}, rpc.Errorf(rpc.KindAborted, "process.write was cancelled while an earlier write to process %s was in progress", p.id)
	case <-turn.C:
		return Empty{}, rpc.Errorf(rpc.KindTimeout, "process %s did not read its input: an earlier write still waited on it after %v, and none of this one's %d bytes were written", p.id, writeTimeout, len(params.Data))
	}
	defer p.unlockInput()
	if ctx.Err() != nil {
		return Empty{}, rpc.Errorf(rpc.KindAborted, "process.write was cancelled before it began")
	}
	switch {
	case p.takesNone:
		return Empty{}, rpc.Errorf(rpc.KindInvalid, "process %s was started without stdin", p.id)
	case p.input == nil && p.hasEnded():
		return Empty{}, rpc.Errorf(rpc.KindInvalid, "process %s has ended", p.id)
	case p.input == nil:
		return Empty{}, rpc.Errorf(rpc.KindInvalid, "process %s's stdin is closed", p.id)
	}
	if len(params.Data) > 0 {
		_ = p.input.SetWriteDeadline(by)
		cut := make(chan struct{})
		stop := context.AfterFunc(ctx, func() {
			defer close(cut)
			_ = p.input.SetWriteDeadline(time.Now())
		})
		n, err := p.input.Write(params.Data)
		if !stop() {
			// The cancel came: its deadline must be set before the next write sets its own.
			<-cut
		}
		switch {
		case err == nil:
		case ctx.Err() != nil:
			return Empty{}, rpc.Errorf(rpc.KindAborted, "process.write was cancelled after %d of %d bytes", n, len(params.Data))
		case errors.Is(err, os.ErrDeadlineExceeded):
			return Empty{}, rpc.Errorf(rpc.KindTimeout, "process %s did not read its input: %d of %d bytes were written in %v", p.id, n, len(params.Data), writeTimeout)
		case errors.Is(err, syscall.EPIPE), errors.Is(err, syscall.EIO), errors.Is(err, os.ErrClosed):
			return Empty{}, rpc.Errorf(rpc.KindInvalid, "process %s no longer reads its input: it closed its stdin, or ended (%d of %d bytes were written)", p.id, n, len(params.Data))
		default:
			return Empty{}, fmt.Errorf("cannot write to process %s: %w", p.id, err)
		}
	}
	if params.Close {
		_ = p.input.Close()
		p.input = nil
	}
	return Empty{}, nil
}

// Signal sends a signal through the program's guard. Where it goes: INT to a process started with a pty is ^C, so it
// goes to the terminal's foreground process group (the job a shell runs in the foreground, or the program itself when
// it runs none), which must be in the program's own session: the program leads that session, so the group is under
// its guard, and a group in another session is refused. The guard checks the group again right before it signals it:
// one with no process left in the program's session by then (it ended, and its id may have gone to a group in another
// session) is not signalled, and the note says INT was not sent. A terminal with no foreground group left has INT go
// to the program's own group, with a note that says so. Every other signal, and INT without a pty, goes to the program's
// group. A signal to a process that has ended does nothing.
func (t *Table) Signal(params SignalParams) (SignalResult, error) {
	sig, ok := signals[params.Signal]
	if !ok {
		return SignalResult{}, rpc.Errorf(rpc.KindInvalid, "signal is TERM, INT, KILL or HUP, not %q", params.Signal)
	}
	p, err := t.get(params.ID)
	if err != nil {
		return SignalResult{}, err
	}
	if p.hasEnded() {
		return SignalResult{}, nil
	}
	if !p.pty || sig != syscall.SIGINT {
		return SignalResult{}, p.g.Signal(sig)
	}
	p.mu.Lock()
	group, session, err := 0, 0, errNoForeground
	if p.terminal != nil {
		group, session, err = foreground(p.terminal)
	}
	p.mu.Unlock()
	switch {
	case err != nil:
		return SignalResult{Note: err.Error() + "; INT went to the program's own group"}, p.g.Signal(sig)
	case session != p.pid:
		return SignalResult{}, rpc.Errorf(rpc.KindDenied, "process %s's terminal belongs to another session: its foreground group %d is in session %d, not the program's, %d; INT was not sent", p.id, group, session, p.pid)
	}
	sent, why, err := p.g.SignalGroup(sig, group)
	if err != nil || sent {
		return SignalResult{}, err
	}
	return SignalResult{Note: why + "; INT was not sent"}, nil
}

func (t *Table) Resize(params ResizeParams) (Empty, error) {
	size := Size{Cols: params.Cols, Rows: params.Rows}
	if err := checkSize(size); err != nil {
		return Empty{}, err
	}
	p, err := t.get(params.ID)
	if err != nil {
		return Empty{}, err
	}
	if !p.pty {
		return Empty{}, rpc.Errorf(rpc.KindInvalid, "process %s has no terminal", p.id)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.terminal == nil || p.hasEnded() {
		return Empty{}, rpc.Errorf(rpc.KindInvalid, "process %s has ended", p.id)
	}
	return Empty{}, setSize(p.terminal, size)
}

// List answers the processes in start order whose seq is from on, as many as fit maxListBytes of JSON; truncated says
// more follow, from next. Paging by seq, not by place in the table, a process dropped between two pages moves no other
// past the cursor. An argv over maxListedArgv of JSON is listed by its first arguments that fit, with ArgvClipped set.
func (t *Table) List(params ListParams) (ListResult, error) {
	from := int64(0)
	if params.From != nil {
		if from = *params.From; from < 0 {
			return ListResult{}, rpc.Errorf(rpc.KindInvalid, "from must be 0 or more: the next of the page before")
		}
	}
	t.mu.Lock()
	first := sort.Search(len(t.procs), func(i int) bool { return t.procs[i].seq >= from })
	procs := append([]*proc(nil), t.procs[first:]...)
	t.mu.Unlock()
	res := ListResult{Processes: []Info{}, Next: from}
	size := 0
	for _, p := range procs {
		p.mu.Lock()
		exit := p.exit()
		info := Info{ID: p.id, Pid: p.pid, Pty: p.pty, Running: exit.Running, ExitCode: exit.ExitCode, Signal: exit.Signal, StartedAt: p.started.UnixMilli()}
		if !exit.Running {
			ended := p.endedAt.UnixMilli()
			info.EndedAt = &ended
		}
		p.mu.Unlock()
		info.Argv, info.ArgvClipped = clipArgv(p.argv)
		data, err := json.Marshal(info)
		if err != nil {
			return ListResult{}, err
		}
		if size += len(data) + 1; size > maxListBytes {
			res.Truncated = true
			break
		}
		res.Processes = append(res.Processes, info)
		res.Next = p.seq + 1
	}
	return res, nil
}

// clipArgv keeps the first arguments of argv that fit maxListedArgv of JSON.
func clipArgv(argv []string) ([]string, bool) {
	size := 2
	for i, arg := range argv {
		data, _ := json.Marshal(arg)
		if size += len(data) + 1; size > maxListedArgv {
			return argv[:i], true
		}
	}
	return argv, false
}

// exit is how p ended, or that it runs. Hold p.mu.
func (p *proc) exit() WaitResult {
	if !p.hasEnded() {
		return WaitResult{Running: true}
	}
	res := WaitResult{ExitCode: p.exitCode}
	if p.signal != "" {
		signal := p.signal
		res.Signal = &signal
	}
	return res
}

func (t *Table) Wait(ctx context.Context, params WaitParams) (WaitResult, error) {
	if params.TimeoutMs == nil || *params.TimeoutMs < 0 || *params.TimeoutMs > maxWaitTimeoutMs {
		return WaitResult{}, rpc.Errorf(rpc.KindInvalid, "timeoutMs is required, from 0 to %d (a day)", maxWaitTimeoutMs)
	}
	p, err := t.get(params.ID)
	if err != nil {
		return WaitResult{}, err
	}
	timer := time.NewTimer(time.Duration(*params.TimeoutMs) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-p.ended:
	case <-timer.C:
	case <-ctx.Done():
		if !p.hasEnded() {
			return WaitResult{}, rpc.Errorf(rpc.KindAborted, "process.wait was cancelled")
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exit(), nil
}

func checkSize(size Size) error {
	if size.Cols < 1 || size.Cols > 65535 || size.Rows < 1 || size.Rows > 65535 {
		return rpc.Errorf(rpc.KindInvalid, "a terminal is from 1 to 65535 columns and rows, not %dx%d", size.Cols, size.Rows)
	}
	return nil
}

func closeAll(files ...*os.File) {
	for _, f := range files {
		_ = f.Close()
	}
}
