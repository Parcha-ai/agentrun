package probe

import (
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// SocketRoots are where a unix socket with a path that a program could reach is looked for. A network namespace does not
// cut a path socket, and /proc/net/unix lists only the sockets of the reader's own namespace, so the filesystem is walked.
var SocketRoots = []string{"/run", "/tmp", "/var/run", "/var/tmp", "/dev/shm", "/workspace", "/work", "/home", "/opt"}

// SocketBounds bound the walk of each root, so a large tree (a mounted run folder) costs the probe a bounded time and
// cannot leave another root unsearched: Entries per root, and folders at most Depth levels below it.
type SocketBounds struct {
	Entries int
	Depth   int
}

// DefaultSocketBounds are the probe's.
var DefaultSocketBounds = SocketBounds{Entries: 50_000, Depth: 8}

// Socket is one socket a program could connect to: its real path, or its abstract name as /proc/net/unix gives it
// (@...), and the type that connected (stream, dgram or seqpacket).
type Socket struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

// SocketSearch is what ConnectableSockets found: the sockets; for each root it could not search whole, why, in words;
// and the folders it did not go into because no socket can be a file there (Skipped, each with its filesystem). A
// search with any Incomplete is no proof that nothing else is reachable; Skipped takes nothing from the proof.
type SocketSearch struct {
	Sockets    []Socket `json:"sockets"`
	Incomplete []string `json:"incomplete"`
	Skipped    []string `json:"skipped"`
}

// socketless are the filesystems, by the type the mount table names, that no unix socket can be a file of: the kernel's
// own views (of its processes, devices, control groups, tracing, security modules, BPF objects, configuration, crash
// records, binary formats, FUSE connections, and autofs's trigger points), none of which can make a socket's file. A
// container runtime may mount them inside a searched root: Cloudflare's mounts proc and sysfs at /run/cloudchamber,
// about 58,000 entries, which filled the 50,000-entry budget of /run before (cloudflare-run-measure-1, 11-17; the only
// socket in /run there was computerd's own).
var socketless = map[string]bool{
	"proc": true, "sysfs": true, "cgroup": true, "cgroup2": true, "debugfs": true, "tracefs": true, "securityfs": true,
	"bpf": true, "configfs": true, "pstore": true, "binfmt_misc": true, "fusectl": true, "autofs": true,
}

// readMounts is the mount table at path (/proc/self/mountinfo's form): each mount point, by its path, with the type of
// the mount on top there. nil when it cannot be read: then no folder is skipped.
func readMounts(path string) map[string]string {
	text, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	mounts := map[string]string{}
	for _, line := range strings.Split(string(text), "\n") {
		fields := strings.Fields(line)
		for i := 6; i+1 < len(fields); i++ {
			if fields[i] == "-" && len(fields) > 4 {
				mounts[unescapeMount(fields[4])] = fields[i+1] // a later line is mounted over an earlier one
				break
			}
		}
	}
	return mounts
}

// unescapeMount undoes the kernel's octal escapes of a mount point (\040 a space, \011 a tab, \012 a newline, \134 a
// backslash).
func unescapeMount(path string) string {
	for _, pair := range [][2]string{{`\040`, " "}, {`\011`, "\t"}, {`\012`, "\n"}, {`\134`, `\`}} {
		path = strings.ReplaceAll(path, pair[0], pair[1])
	}
	return path
}

// mountsBelow are the mounts strictly below the folder at path that a socket can be a file of, and that no other such
// mount below path holds: walking each of them reaches the rest.
func mountsBelow(mounts map[string]string, path string) []string {
	prefix := strings.TrimSuffix(path, string(filepath.Separator)) + string(filepath.Separator)
	below := []string{}
	for point, kind := range mounts {
		if strings.HasPrefix(point, prefix) && !socketless[kind] {
			below = append(below, point)
		}
	}
	sort.Strings(below)
	outer := []string{}
	for _, point := range below {
		if len(outer) == 0 || !strings.HasPrefix(point, outer[len(outer)-1]+string(filepath.Separator)) {
			outer = append(outer, point)
		}
	}
	return outer
}

// The socket types a connect is tried with, each by Go's network name and the name reported.
var socketTypes = []struct{ network, name string }{{"unix", "stream"}, {"unixgram", "dgram"}, {"unixpacket", "seqpacket"}}

// ConnectableSockets lists the unix sockets that the calling process can connect to: every socket found by walking
// roots (each root by its real path, links never followed, each within bounds of its own), and every path and abstract
// name (@...) in the table at netUnix (/proc/net/unix, the sockets of the reader's network namespace). An abstract name
// is in no folder: the network namespace holds it, so every program in the namespace reaches it, and the table alone
// names it. Each is tried with a connect of each type, bounded by timeout, at once; the real paths and names of those
// that accept, with the type, sorted. A root whose walk reached a bound, and a table that could not be read, are named
// in Incomplete. A mount point, by the mount table at mountinfo (/proc/self/mountinfo), of a filesystem no socket can
// be a file of (socketless: proc, sysfs and the kernel's other views) is not gone into, and is named in Skipped; a mount
// below it that can hold a socket is walked still, within the same root's bounds.
func ConnectableSockets(roots []string, netUnix, mountinfo string, bounds SocketBounds, timeout time.Duration) SocketSearch {
	candidates := map[string]bool{}
	add := func(path string) {
		real, err := filepath.EvalSymlinks(path)
		if err != nil {
			return
		}
		if info, err := os.Lstat(real); err == nil && info.Mode()&fs.ModeSocket != 0 {
			candidates[real] = true
		}
	}
	incomplete := []string{}
	skipped := []string{}
	mounts := readMounts(mountinfo)
	seen := map[string]bool{}
	for _, root := range roots {
		real, err := filepath.EvalSymlinks(root)
		if err != nil || seen[real] {
			continue
		}
		seen[real] = true
		base := strings.Count(real, string(filepath.Separator))
		entries, tooDeep, stopped := 0, false, false
		under := map[string]int{} // entries walked below each folder or file at the root's top level
		pending := []string{real} // the root, then the mounts below a skipped folder
		visit := func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return nil // unreadable: skipped, as a program could not reach in either
			}
			entries++
			if entries > bounds.Entries {
				stopped = true
				return filepath.SkipAll
			}
			if rel, err := filepath.Rel(real, path); err == nil && rel != "." {
				under[filepath.Join(real, strings.SplitN(rel, string(filepath.Separator), 2)[0])]++
			}
			if kind, ok := mounts[path]; ok && entry.IsDir() && socketless[kind] {
				skipped = append(skipped, fmt.Sprintf("%s (%s)", path, kind))
				pending = append(pending, mountsBelow(mounts, path)...)
				return filepath.SkipDir
			}
			if entry.IsDir() && path != real && strings.Count(path, string(filepath.Separator))-base >= bounds.Depth {
				tooDeep = true
				return filepath.SkipDir
			}
			if entry.Type()&fs.ModeSocket != 0 {
				add(path)
			}
			return nil
		}
		for len(pending) > 0 && !stopped {
			next := pending[0]
			pending = pending[1:]
			_ = filepath.WalkDir(next, visit)
		}
		switch {
		case stopped:
			incomplete = append(incomplete, fmt.Sprintf("%s: the walk stopped after %d entries, its budget (most under %s)", real, bounds.Entries, heaviest(under, 3)))
		case tooDeep:
			incomplete = append(incomplete, fmt.Sprintf("%s: folders deeper than %d levels were not searched", real, bounds.Depth))
		}
	}
	table, err := os.ReadFile(netUnix)
	if err != nil {
		incomplete = append(incomplete, fmt.Sprintf("%s: cannot be read, so no abstract name was tried: %v", netUnix, err))
	}
	for _, line := range strings.Split(string(table), "\n") {
		switch name := unixSocketName(line); {
		case strings.HasPrefix(name, "/"):
			add(name)
		case strings.HasPrefix(name, "@"):
			candidates[name] = true // Go dials a name that starts with @ as an abstract one
		}
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sockets := []Socket{}
	for path := range candidates {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for _, kind := range socketTypes {
				conn, err := net.DialTimeout(kind.network, path, timeout)
				if err != nil {
					continue
				}
				conn.Close()
				mu.Lock()
				sockets = append(sockets, Socket{Path: path, Type: kind.name})
				mu.Unlock()
				return
			}
		}()
	}
	wg.Wait()
	sort.Slice(sockets, func(i, j int) bool { return sockets[i].Path < sockets[j].Path })
	return SocketSearch{Sockets: sockets, Incomplete: incomplete, Skipped: skipped}
}

// heaviest names the n paths with the most entries walked below them, most first, each with its count, so a walk that
// stopped at its budget says what filled it.
func heaviest(under map[string]int, n int) string {
	paths := make([]string, 0, len(under))
	for path := range under {
		paths = append(paths, path)
	}
	sort.Slice(paths, func(i, j int) bool {
		if under[paths[i]] != under[paths[j]] {
			return under[paths[i]] > under[paths[j]]
		}
		return paths[i] < paths[j]
	})
	if len(paths) > n {
		paths = paths[:n]
	}
	named := make([]string, len(paths))
	for i, path := range paths {
		named[i] = fmt.Sprintf("%s %d", path, under[path])
	}
	return strings.Join(named, ", ")
}

// unixSocketName is the name a line of /proc/net/unix gives its socket, or "" for one with none (and for the header).
// The kernel writes seven columns, then one space and the name as it is, spaces and all, so the name is the rest of
// the line after that space, not a field.
func unixSocketName(line string) string {
	rest := line
	for range 7 {
		rest = strings.TrimLeft(rest, " ")
		end := strings.IndexByte(rest, ' ')
		if end < 0 {
			return ""
		}
		rest = rest[end:]
	}
	return strings.TrimPrefix(rest, " ")
}
