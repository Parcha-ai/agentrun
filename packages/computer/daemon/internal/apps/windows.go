package apps

import (
	"bytes"
	"context"
	"os"
	"strconv"
	"strings"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11"
)

// window is one app window that shows: its id, the process that made it (_NET_WM_PID, 0 when it names none), its
// WM_CLASS (instance, class) and the app it is, "" when no app's.
type window struct {
	id    uint32
	pid   int
	class [2]string
	app   string
}

// snapshot is the apps and the windows that show, at one moment: windows bottom of the stack first, active the window
// manager's active window (0 for none, or no window manager), wm whether a window manager runs.
type snapshot struct {
	entries []Entry
	windows []window
	active  uint32
	wm      bool
	atoms   atoms
}

type atoms struct {
	pid, active, stacking, check uint32
}

// of is the app's windows that show, bottom first.
func (s *snapshot) of(app string) []window {
	var out []window
	for _, w := range s.windows {
		if w.app == app {
			out = append(out, w)
		}
	}
	return out
}

// front is the window in front: the window manager's active one when it shows, else the top of the stack; nil when
// no window shows.
func (s *snapshot) front() *window {
	for i := range s.windows {
		if s.active != 0 && s.windows[i].id == s.active {
			return &s.windows[i]
		}
	}
	if len(s.windows) == 0 {
		return nil
	}
	return &s.windows[len(s.windows)-1]
}

// look reads the apps and the windows now.
func (g *group) look() (*snapshot, error) {
	c, err := g.display.Conn()
	if err != nil {
		return nil, err
	}
	s, err := g.read(c)
	if err != nil {
		return nil, g.display.Gone(c, err)
	}
	return s, nil
}

func (g *group) read(c *x11.Conn) (*snapshot, error) {
	s := &snapshot{entries: g.entries()}
	for _, a := range []struct {
		name string
		into *uint32
	}{
		{"_NET_WM_PID", &s.atoms.pid},
		{"_NET_ACTIVE_WINDOW", &s.atoms.active},
		{"_NET_CLIENT_LIST_STACKING", &s.atoms.stacking},
		{"_NET_SUPPORTING_WM_CHECK", &s.atoms.check},
	} {
		atom, err := c.InternAtom(a.name, true)
		if err != nil {
			return nil, err
		}
		*a.into = atom
	}
	root := c.Screen().Root
	first := func(atom uint32) uint32 {
		if atom == 0 {
			return 0
		}
		p, err := c.GetProperty(root, atom)
		if err != nil || len(p.Cardinals()) == 0 {
			return 0
		}
		return p.Cardinals()[0]
	}
	s.wm = first(s.atoms.check) != 0
	if s.wm {
		s.active = first(s.atoms.active)
	}
	// The window manager's own list of the apps' windows, bottom first; else the root's children that show, each one
	// itself or (a frame) the child of it that has a class.
	var tops []uint32
	if s.wm && s.atoms.stacking != 0 {
		if p, err := c.GetProperty(root, s.atoms.stacking); err == nil && p.Type == x11.AtomWindow {
			tops = p.Cardinals()
		}
	}
	if tops == nil {
		children, err := c.QueryTree(root)
		if err != nil {
			return nil, err
		}
		for _, child := range children {
			if attrs, err := c.GetWindowAttributes(child); err != nil || attrs.MapState != x11.IsViewable || attrs.OverrideRedirect {
				continue
			}
			if client := classed(c, child, 2); client != 0 {
				tops = append(tops, client)
			}
		}
	}
	byPid := g.livePids()
	for _, id := range tops {
		if attrs, err := c.GetWindowAttributes(id); err != nil || attrs.MapState != x11.IsViewable {
			if c.Err() != nil {
				return nil, c.Err()
			}
			continue
		}
		w := window{id: id, class: classOf(c, id)}
		if s.atoms.pid != 0 {
			if p, err := c.GetProperty(id, s.atoms.pid); err == nil && len(p.Cardinals()) > 0 {
				w.pid = int(p.Cardinals()[0])
			}
		}
		w.app = ownerByPid(byPid, w.pid)
		if w.app == "" {
			w.app = ownerByClass(s.entries, w.class)
		}
		s.windows = append(s.windows, w)
	}
	if c.Err() != nil {
		return nil, c.Err()
	}
	return s, nil
}

// classed is the window, or the first of its children down to depth more levels, that has a WM_CLASS; 0 for none.
func classed(c *x11.Conn, id uint32, depth int) uint32 {
	if p, err := c.GetProperty(id, x11.AtomWMClass); err == nil && len(p.Value) > 0 {
		return id
	}
	if depth == 0 {
		return 0
	}
	children, err := c.QueryTree(id)
	if err != nil {
		return 0
	}
	for i := len(children) - 1; i >= 0; i-- {
		if found := classed(c, children[i], depth-1); found != 0 {
			return found
		}
	}
	return 0
}

// classOf is a window's WM_CLASS: its instance and its class.
func classOf(c *x11.Conn, id uint32) [2]string {
	p, err := c.GetProperty(id, x11.AtomWMClass)
	if err != nil {
		return [2]string{}
	}
	parts := bytes.SplitN(bytes.TrimRight(p.Value, "\x00"), []byte{0}, 2)
	var out [2]string
	for i, part := range parts {
		out[i] = string(part)
	}
	return out
}

// livePids are the pids of the launches that still run, each with its app. An ended launch's pid is not among them: the
// system may have handed it to another process since.
func (g *group) livePids() map[int]string {
	g.mu.Lock()
	apps := make([]string, 0, len(g.launched))
	for app := range g.launched {
		apps = append(apps, app)
	}
	g.mu.Unlock()
	byPid := map[int]string{}
	for _, app := range apps {
		for _, l := range g.launches(app) {
			byPid[l.pid] = app
		}
	}
	return byPid
}

// ownerByPid is the app whose running launch made the process pid (it, or a process it started), or "".
func ownerByPid(byPid map[int]string, pid int) string {
	if pid <= 1 || len(byPid) == 0 {
		return ""
	}
	for step := 0; step < 32 && pid > 1; step++ {
		if app, ok := byPid[pid]; ok {
			return app
		}
		pid = parentOf(pid)
	}
	return ""
}

// parentOf is a process's parent, from /proc/<pid>/stat; 0 when it is gone.
func parentOf(pid int) int {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0
	}
	// pid (comm) state ppid ...: comm may hold spaces and parentheses, so read after its last ")".
	rest := string(b[bytes.LastIndexByte(b, ')')+1:])
	fields := strings.Fields(rest)
	if len(fields) < 2 {
		return 0
	}
	ppid, _ := strconv.Atoi(fields[1])
	return ppid
}

// front brings the window to the front: through the window manager when one runs (EWMH _NET_ACTIVE_WINDOW, as a
// pager asks), else by raising it and giving it the keyboard focus. It holds the display meanwhile. The X server's
// refusal (the window went in between) is no error: the launch's window showed.
func (g *group) front(ctx context.Context, w window, s *snapshot) error {
	release, err := g.display.Use(ctx, "apps.launch")
	if err != nil {
		return err
	}
	defer release()
	c, err := g.display.Conn()
	if err != nil {
		return err
	}
	if s.wm && s.atoms.active != 0 {
		err = c.SendClientMessage(w.id, s.atoms.active, [5]uint32{2, 0, 0, 0, 0})
	} else {
		err = c.Raise(w.id)
		if err == nil {
			err = c.SetInputFocus(w.id)
		}
	}
	if err == nil {
		_, err = c.Sync()
	}
	if err != nil && c.Err() != nil {
		return g.display.Gone(c, err)
	}
	return nil
}
