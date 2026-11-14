// Package apps is a Linux desktop's apps group (src/protocol.ts, the same methods and answers as a Mac's): apps.list
// reads the desktop files of the apps there are, apps.launch opens one on the display and answers once its window
// shows, apps.terminate ends it. An app is launched as process.start launches a program with orphans "keep": it is in
// computerd's process table, with DISPLAY, and what it starts runs on after its launcher ends, to the computer's end.
//
// Windows are read on the display's own connection (package desktop): the top-level windows that are the apps' own (a
// window manager's frames looked into), each one's app by the process that launched it (_NET_WM_PID) and else by its
// WM_CLASS, and the one in front by the window manager's _NET_ACTIVE_WINDOW, else the top of the stack.
package apps

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sync"
	"syscall"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/desktop"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// LaunchWindow is the longest apps.launch waits for the app's window: the protocol's LAUNCH_WINDOW_MS.
const LaunchWindow = 10 * time.Second

// endWait is how long apps.terminate waits for the app's windows to go after TERM, and again after KILL.
const endWait = 3 * time.Second

// poll is how often a launch or a terminate looks at the windows again.
const poll = 50 * time.Millisecond

// Options are what a test sets; zero values are the desktop's own.
type Options struct {
	// Dirs is where desktop files are read, first first; nil is ApplicationDirs().
	Dirs []string
	// Window is apps.launch's wait for a window; 0 is LaunchWindow.
	Window time.Duration
}

// App is one app as apps.list gives it.
type App struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

// ListResult is apps.list's answer.
type ListResult struct {
	Apps       []App   `json:"apps"`
	Foreground *string `json:"foreground"`
}

type listParams struct{}

type launchParams struct {
	ID         string `json:"id"`
	URL        string `json:"url,omitempty"`
	Background bool   `json:"background,omitempty"`
}

type terminateParams struct {
	ID string `json:"id"`
}

type group struct {
	display *desktop.Display
	table   *process.Table
	dirs    []string
	window  time.Duration

	// mu guards launched: the process table's ids of the launches of each app, which its terminate ends and its windows
	// are known by.
	mu       sync.Mutex
	launched map[string][]launch
}

type launch struct {
	id  string
	pid int
}

// Handlers are apps.list, apps.launch and apps.terminate on display, launching into table.
func Handlers(display *desktop.Display, table *process.Table, options Options) map[string]rpc.Handler {
	g := &group{display: display, table: table, dirs: options.Dirs, window: options.Window, launched: map[string][]launch{}}
	if g.window <= 0 {
		g.window = LaunchWindow
	}
	return map[string]rpc.Handler{
		"apps.list":      g.list,
		"apps.launch":    g.launch,
		"apps.terminate": g.terminate,
	}
}

func (g *group) entries() []Entry {
	if g.dirs != nil {
		return Entries(g.dirs)
	}
	return Entries(ApplicationDirs())
}

// find is the app asked for, or not_found in words.
func (g *group) find(entries []Entry, asked string) (Entry, error) {
	if asked == "" {
		return Entry{}, rpc.Errorf(rpc.KindInvalid, "id names the app: an id apps.list gives, or its name")
	}
	e, ok := Find(entries, asked)
	if !ok {
		return Entry{}, rpc.Errorf(rpc.KindNotFound, "this desktop has no app %q: apps.list names the ones it has", asked)
	}
	return e, nil
}

func (g *group) list(_ context.Context, raw json.RawMessage) (any, error) {
	var params listParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	s, err := g.look()
	if err != nil {
		return nil, err
	}
	out := ListResult{Apps: make([]App, 0, len(s.entries))}
	for _, e := range s.entries {
		out.Apps = append(out.Apps, App{ID: e.ID, Name: e.Name})
	}
	if front := s.front(); front != nil && front.app != "" {
		app := front.app
		out.Foreground = &app
	}
	return out, nil
}

func (g *group) launch(ctx context.Context, raw json.RawMessage) (any, error) {
	var params launchParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	if params.Background {
		return nil, rpc.Errorf(rpc.KindUnsupported, "a Linux desktop opens an app in front: apps.background is not one of its features")
	}
	before, err := g.look()
	if err != nil {
		return nil, err
	}
	e, err := g.find(before.entries, params.ID)
	if err != nil {
		return nil, err
	}
	argv, err := e.Argv(params.URL)
	if err != nil {
		return nil, rpc.Errorf(rpc.KindInvalid, "%v", err)
	}
	had := map[uint32]bool{}
	for _, w := range before.of(e.ID) {
		had[w.id] = true
	}
	// An app already running with a window answers at once (wire.md, apps.launch), its window brought to the front, as
	// a Mac's does. A url is handed to it by a launch: the app's own launcher passes it to the instance that runs.
	if shown := before.of(e.ID); len(shown) > 0 && params.URL == "" {
		if err := g.front(ctx, shown[len(shown)-1], before); err != nil {
			return nil, err
		}
		return struct{}{}, nil
	}
	started, err := g.table.Start(ctx, process.StartParams{Argv: argv, Env: map[string]string{"DISPLAY": g.display.Name()}, Orphans: "keep"})
	if err != nil {
		return nil, err
	}
	g.mu.Lock()
	g.launched[e.ID] = append(g.launched[e.ID], launch{id: started.ID, pid: started.Pid})
	g.mu.Unlock()
	deadline := time.Now().Add(g.window)
	for {
		now, err := g.look()
		if err != nil {
			return nil, err
		}
		shown := now.of(e.ID)
		// A new window of the app's; or, when it had one before and the launch ended (a second launch of a single-
		// instance app hands its work to the first), the one it has.
		var pick *window
		for i := range shown {
			if !had[shown[i].id] {
				pick = &shown[i]
			}
		}
		if pick == nil && len(shown) > 0 && !g.running(started.ID) {
			pick = &shown[len(shown)-1]
		}
		if pick != nil {
			if err := g.front(ctx, *pick, now); err != nil {
				return nil, err
			}
			return struct{}{}, nil
		}
		if time.Now().After(deadline) {
			return nil, rpc.Errorf(rpc.KindTimeout, "%s showed no window within %s of its launch (%s): it may still be starting, and apps.terminate ends it", e.ID, seconds(g.window), g.ended(started.ID))
		}
		select {
		case <-ctx.Done():
			return nil, rpc.Errorf(rpc.KindAborted, "apps.launch of %s was cancelled while it waited for the app's window", e.ID)
		case <-time.After(poll):
		}
	}
}

func (g *group) terminate(ctx context.Context, raw json.RawMessage) (any, error) {
	var params terminateParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	s, err := g.look()
	if err != nil {
		return nil, err
	}
	e, err := g.find(s.entries, params.ID)
	if err != nil {
		return nil, err
	}
	for _, sig := range []string{"TERM", "KILL"} {
		g.signal(e.ID, s, sig)
		deadline := time.Now().Add(endWait)
		for {
			if s, err = g.look(); err != nil {
				return nil, err
			}
			if len(s.of(e.ID)) == 0 {
				return struct{}{}, nil
			}
			if time.Now().After(deadline) {
				break
			}
			select {
			case <-ctx.Done():
				return nil, rpc.Errorf(rpc.KindAborted, "apps.terminate of %s was cancelled while it waited for the app's windows to go", e.ID)
			case <-time.After(poll):
			}
		}
	}
	return nil, rpc.Errorf(rpc.KindTimeout, "%s still shows a window %s after it was sent TERM and then KILL", e.ID, seconds(2*endWait))
}

// signal sends sig to every launch of the app (through the process table's guard) and to each process one of its
// windows names. A process this daemon may not signal is left: it is not the tool user's.
func (g *group) signal(app string, s *snapshot, sig string) {
	g.mu.Lock()
	launches := slices.Clone(g.launched[app])
	g.mu.Unlock()
	for _, l := range launches {
		_, _ = g.table.Signal(process.SignalParams{ID: l.id, Signal: sig})
	}
	n := syscall.SIGTERM
	if sig == "KILL" {
		n = syscall.SIGKILL
	}
	for _, w := range s.of(app) {
		if w.pid > 1 {
			_ = syscall.Kill(w.pid, n)
		}
	}
}

// running is whether the launch with that process id still runs its program.
func (g *group) running(id string) bool {
	zero := int64(0)
	waited, err := g.table.Wait(context.Background(), process.WaitParams{ID: id, TimeoutMs: &zero})
	return err == nil && waited.Running
}

// ended says how a launch stands, for a launch's error: running, or how it ended.
func (g *group) ended(id string) string {
	zero := int64(0)
	waited, err := g.table.Wait(context.Background(), process.WaitParams{ID: id, TimeoutMs: &zero})
	switch {
	case err != nil:
		return "its process is gone from the table"
	case waited.Running:
		return fmt.Sprintf("process %s still runs", id)
	case waited.Signal != nil:
		return fmt.Sprintf("process %s ended with signal %s", id, *waited.Signal)
	case waited.ExitCode != nil:
		return fmt.Sprintf("process %s ended with exit code %d", id, *waited.ExitCode)
	}
	return fmt.Sprintf("process %s ended", id)
}

func seconds(d time.Duration) string {
	return fmt.Sprintf("%g s", d.Seconds())
}

func strict(raw json.RawMessage, into any) error {
	if len(raw) == 0 {
		raw = json.RawMessage("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return rpc.Errorf(rpc.KindInvalid, "invalid params: %v", err)
	}
	return nil
}
