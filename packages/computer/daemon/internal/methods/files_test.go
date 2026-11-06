package methods_test

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/methods"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

const chunk = 512 << 10

type message struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			Kind string `json:"kind"`
		} `json:"data"`
	} `json:"error"`
}

func (m message) kind() string {
	if m.Error == nil {
		return ""
	}
	return m.Error.Data.Kind
}

// conn is a client of one daemon connection over pipes. Every line the daemon writes is checked against the limit.
type conn struct {
	t      *testing.T
	in     *io.PipeWriter
	out    *io.PipeReader
	lines  chan []byte
	served chan struct{}
	nextID int
}

func dial(t *testing.T) *conn {
	t.Helper()
	cr, cw := io.Pipe()
	sr, sw := io.Pipe()
	server := rpc.NewServer(methods.Handlers("0.0.0-test"), log.New(io.Discard, "", 0))
	c := &conn{t: t, in: cw, out: sr, lines: make(chan []byte, 1024), served: make(chan struct{})}
	go func() {
		_ = server.Serve(context.Background(), cr, sw)
		_ = cr.Close()
		_ = sw.Close()
		close(c.served)
	}()
	go func() {
		scanner := bufio.NewScanner(sr)
		scanner.Buffer(make([]byte, 0, 64<<10), 4<<20)
		for scanner.Scan() {
			c.lines <- append([]byte(nil), scanner.Bytes()...)
		}
		close(c.lines)
	}()
	t.Cleanup(func() {
		_ = cw.Close()
		_ = sr.Close()
	})
	return c
}

func (c *conn) send(id int, method string, params any) {
	c.t.Helper()
	line, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err != nil {
		c.t.Fatal(err)
	}
	if _, err := c.in.Write(append(line, '\n')); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *conn) next() message {
	c.t.Helper()
	select {
	case line, ok := <-c.lines:
		if !ok {
			c.t.Fatal("the daemon closed its output")
		}
		if len(line) > rpc.MaxLine {
			c.t.Fatalf("the daemon wrote a %d-byte line, over the limit", len(line))
		}
		var m message
		if err := json.Unmarshal(line, &m); err != nil {
			c.t.Fatalf("not JSON: %.200q", line)
		}
		return m
	case <-time.After(10 * time.Second):
		c.t.Fatal("nothing from the daemon within 10 s")
	}
	return message{}
}

// call sends a request and returns its reply, with the notifications that came first.
func (c *conn) call(method string, params any) (message, []message) {
	c.t.Helper()
	c.nextID++
	id := c.nextID
	c.send(id, method, params)
	var notes []message
	for {
		m := c.next()
		if m.ID == nil {
			notes = append(notes, m)
			continue
		}
		if string(m.ID) != fmt.Sprint(id) {
			c.t.Fatalf("a reply to %s while waiting for %d", m.ID, id)
		}
		return m, notes
	}
}

// ok calls and decodes the result, failing on an error reply.
func (c *conn) ok(method string, params any, into any) []message {
	c.t.Helper()
	r, notes := c.call(method, params)
	if r.Error != nil {
		c.t.Fatalf("%s %s: %s (%s)", method, brief(params), r.Error.Message, r.kind())
	}
	if into != nil {
		if err := json.Unmarshal(r.Result, into); err != nil {
			c.t.Fatalf("%s result %s: %v", method, r.Result, err)
		}
	}
	return notes
}

// fails calls and checks the error kind.
func (c *conn) fails(method string, params any, kind string) message {
	c.t.Helper()
	r, _ := c.call(method, params)
	if r.Error == nil || r.kind() != kind {
		c.t.Fatalf("%s %s: want %s, got %s %+v", method, brief(params), kind, r.Result, r.Error)
	}
	return r
}

// brief is params as JSON, cut short for a failure message.
func brief(params any) string {
	data, _ := json.Marshal(params)
	if len(data) > 160 {
		return string(data[:160]) + "..."
	}
	return string(data)
}

type entry struct {
	Path    string `json:"path"`
	Type    string `json:"type"`
	Size    int64  `json:"size"`
	Mode    uint32 `json:"mode"`
	MtimeMs int64  `json:"mtimeMs"`
	UID     uint32 `json:"uid"`
	GID     uint32 `json:"gid"`
	Target  string `json:"target"`
}

type readResult struct {
	Data []byte `json:"data"`
	EOF  bool   `json:"eof"`
	Size int64  `json:"size"`
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestHelloOffersFiles(t *testing.T) {
	c := dial(t)
	var hello methods.HelloResult
	c.ok("hello", map[string]any{"client": "test"}, &hello)
	if strings.Join(hello.Capabilities, ",") != "exec,files" {
		t.Fatalf("capabilities %v", hello.Capabilities)
	}
}

func TestWriteReadAndStat(t *testing.T) {
	c := dial(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")
	var wrote struct{ Size int64 }
	c.ok("files.write", map[string]any{"path": path, "data": []byte("hello"), "mode": 0o640}, &wrote)
	if wrote.Size != 5 {
		t.Fatalf("size %d", wrote.Size)
	}
	var read readResult
	c.ok("files.read", map[string]any{"path": path}, &read)
	if string(read.Data) != "hello" || !read.EOF || read.Size != 5 {
		t.Fatalf("read %+v", read)
	}
	var stat entry
	c.ok("files.stat", map[string]any{"path": path}, &stat)
	if stat.Type != "file" || stat.Size != 5 || stat.Mode != 0o640 || stat.UID != uint32(os.Getuid()) || stat.GID != uint32(os.Getgid()) || stat.Path != "" {
		t.Fatalf("stat %+v", stat)
	}
	if age := time.Now().UnixMilli() - stat.MtimeMs; age < 0 || age > 60_000 {
		t.Fatalf("mtimeMs %d is not now", stat.MtimeMs)
	}
	c.ok("files.write", map[string]any{"path": path, "data": []byte("hi")}, &wrote)
	if c.ok("files.read", map[string]any{"path": path}, &read); string(read.Data) != "hi" || wrote.Size != 2 {
		t.Fatalf("a plain write replaces the file: %q, size %d", read.Data, wrote.Size)
	}
	var dirStat entry
	c.ok("files.stat", map[string]any{"path": dir + "/./"}, &dirStat)
	if dirStat.Type != "dir" {
		t.Fatalf("stat of a dir %+v", dirStat)
	}
	c.fails("files.read", map[string]any{"path": dir}, "is_dir")
	c.fails("files.write", map[string]any{"path": filepath.Join(dir, "no", "such", "f"), "data": []byte("x")}, "not_found")
	c.ok("files.write", map[string]any{"path": filepath.Join(dir, "made", "deep", "f"), "data": []byte("x"), "parents": true}, &wrote)
}

func TestStatOfASymlink(t *testing.T) {
	c := dial(t)
	dir := t.TempDir()
	must(t, os.WriteFile(filepath.Join(dir, "real"), []byte("12345"), 0o600))
	must(t, os.Symlink("real", filepath.Join(dir, "link")))
	var stat entry
	c.ok("files.stat", map[string]any{"path": filepath.Join(dir, "link")}, &stat)
	if stat.Type != "symlink" || stat.Target != "real" {
		t.Fatalf("lstat %+v", stat)
	}
	c.ok("files.stat", map[string]any{"path": filepath.Join(dir, "link"), "follow": true}, &stat)
	if stat.Type != "file" || stat.Size != 5 || stat.Mode != 0o600 || stat.Target != "" {
		t.Fatalf("stat followed %+v", stat)
	}
}

func TestNotFound(t *testing.T) {
	c := dial(t)
	missing := filepath.Join(t.TempDir(), "missing")
	for method, params := range map[string]map[string]any{
		"files.read":   {"path": missing},
		"files.stat":   {"path": missing},
		"files.list":   {"path": missing},
		"files.mkdir":  {"path": filepath.Join(missing, "child")},
		"files.move":   {"from": missing, "to": missing + "2"},
		"files.remove": {"path": missing},
		"files.write":  {"path": filepath.Join(missing, "f"), "data": ""},
		"tar.pull":     {"path": missing},
		"tar.push.end": {"id": "nope"},
	} {
		r := c.fails(method, params, "not_found")
		if r.Error.Message == "" {
			t.Errorf("%s: no message", method)
		}
	}
}

func TestRelativePathsAreInvalid(t *testing.T) {
	c := dial(t)
	abs := t.TempDir()
	for _, tc := range []struct {
		method string
		params map[string]any
	}{
		{"files.read", map[string]any{"path": "a.txt"}},
		{"files.write", map[string]any{"path": "./a.txt", "data": ""}},
		{"files.stat", map[string]any{"path": "../etc/passwd"}},
		{"files.list", map[string]any{"path": "."}},
		{"files.mkdir", map[string]any{"path": "d"}},
		{"files.move", map[string]any{"from": "a", "to": abs + "/b"}},
		{"files.move", map[string]any{"from": abs + "/a", "to": "b"}},
		{"files.remove", map[string]any{"path": "a"}},
		{"files.stat", map[string]any{"path": ""}},
		{"tar.pull", map[string]any{"path": "a"}},
		{"tar.push.begin", map[string]any{"path": "a"}},
	} {
		r := c.fails(tc.method, tc.params, "invalid")
		if !strings.Contains(r.Error.Message, "absolute") {
			t.Errorf("%s %s: the message does not say why: %s", tc.method, brief(tc.params), r.Error.Message)
		}
	}
}

func TestReadAndWriteAtOffsets(t *testing.T) {
	c := dial(t)
	path := filepath.Join(t.TempDir(), "f")
	var wrote struct{ Size int64 }
	c.ok("files.write", map[string]any{"path": path, "data": []byte("hello world")}, &wrote)
	c.ok("files.write", map[string]any{"path": path, "data": []byte("WORLD"), "offset": 6}, &wrote)
	c.ok("files.write", map[string]any{"path": path, "data": []byte("!"), "append": true}, &wrote)
	if wrote.Size != 12 {
		t.Fatalf("size after append %d", wrote.Size)
	}
	var read readResult
	c.ok("files.read", map[string]any{"path": path, "offset": 6, "length": 5}, &read)
	if string(read.Data) != "WORLD" || read.EOF || read.Size != 12 {
		t.Fatalf("read at 6 for 5: %+v", read)
	}
	c.ok("files.read", map[string]any{"path": path, "offset": 6}, &read)
	if string(read.Data) != "WORLD!" || !read.EOF {
		t.Fatalf("read from 6: %+v", read)
	}
	c.ok("files.read", map[string]any{"path": path, "offset": 100}, &read)
	if len(read.Data) != 0 || !read.EOF {
		t.Fatalf("read past the end: %+v", read)
	}
	c.ok("files.write", map[string]any{"path": path + ".sparse", "data": []byte("x"), "offset": 3}, &wrote)
	if c.ok("files.read", map[string]any{"path": path + ".sparse"}, &read); !bytes.Equal(read.Data, []byte{0, 0, 0, 'x'}) {
		t.Fatalf("an offset write creates the file: %q", read.Data)
	}
	c.fails("files.write", map[string]any{"path": path, "data": "", "offset": 1, "append": true}, "invalid")
	c.fails("files.write", map[string]any{"path": path, "data": "", "offset": -1}, "invalid")
	c.fails("files.write", map[string]any{"path": path, "data": "", "mode": 0o10000}, "invalid")
	c.fails("files.write", map[string]any{"path": path, "data": "not base64!"}, "invalid")
	c.fails("files.read", map[string]any{"path": path, "offset": -1}, "invalid")
	c.fails("files.read", map[string]any{"path": path, "length": 0}, "invalid")
	r := c.fails("files.read", map[string]any{"path": path, "length": chunk + 1}, "limit")
	if !strings.Contains(r.Error.Message, "524288") {
		t.Fatalf("the limit is not in words: %s", r.Error.Message)
	}
}

func TestAThreeMiBFileInChunks(t *testing.T) {
	c := dial(t)
	path := filepath.Join(t.TempDir(), "big.bin")
	want := make([]byte, 3<<20+123)
	_, _ = rand.Read(want)
	for at := 0; at < len(want); at += chunk {
		params := map[string]any{"path": path, "data": want[at:min(at+chunk, len(want))]}
		if at > 0 {
			params["offset"] = at
		}
		c.ok("files.write", params, nil)
	}
	var got []byte
	for {
		var read readResult
		c.ok("files.read", map[string]any{"path": path, "offset": len(got)}, &read)
		if len(read.Data) > chunk || read.Size != int64(len(want)) {
			t.Fatalf("a read of %d bytes, size %d", len(read.Data), read.Size)
		}
		got = append(got, read.Data...)
		if read.EOF {
			break
		}
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("read back %d bytes, not the %d written", len(got), len(want))
	}
}

func paths(root string, entries []entry) []string {
	var out []string
	for _, e := range entries {
		out = append(out, strings.TrimPrefix(e.Path, root+"/")+":"+e.Type)
	}
	return out
}

func TestListDepth(t *testing.T) {
	c := dial(t)
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "a", "b", "c"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "a", "b", "f"), []byte("f"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "top"), []byte("top"), 0o755))
	must(t, os.Symlink("a/b", filepath.Join(root, "link")))
	var list struct {
		Entries   []entry
		Truncated bool
	}
	c.ok("files.list", map[string]any{"path": root}, &list)
	if got := strings.Join(paths(root, list.Entries), " "); got != "a:dir link:symlink top:file" || list.Truncated {
		t.Fatalf("depth 1: %s", got)
	}
	for _, e := range list.Entries {
		if e.Path == root+"/top" && (e.Size != 3 || e.Mode != 0o755 || e.MtimeMs == 0) {
			t.Fatalf("top %+v", e)
		}
		if e.Path == root+"/link" && e.Target != "a/b" {
			t.Fatalf("link %+v", e)
		}
	}
	c.ok("files.list", map[string]any{"path": root, "depth": 2}, &list)
	if got := strings.Join(paths(root, list.Entries), " "); got != "a:dir a/b:dir link:symlink top:file" {
		t.Fatalf("depth 2: %s", got)
	}
	c.ok("files.list", map[string]any{"path": root, "depth": 16}, &list)
	if got := strings.Join(paths(root, list.Entries), " "); got != "a:dir a/b:dir a/b/c:dir a/b/f:file link:symlink top:file" {
		t.Fatalf("depth 16: %s (a symlink is listed, never entered)", got)
	}
	c.ok("files.list", map[string]any{"path": filepath.Join(root, "link")}, &list)
	if got := strings.Join(paths(root, list.Entries), " "); got != "link/c:dir link/f:file" {
		t.Fatalf("a listed symlink to a dir is followed, and paths keep the asked path: %s", got)
	}
	c.fails("files.list", map[string]any{"path": root, "depth": 17}, "invalid")
	c.fails("files.list", map[string]any{"path": root, "depth": 0}, "invalid")
	c.fails("files.list", map[string]any{"path": root, "offset": -1}, "invalid")
	c.fails("files.list", map[string]any{"path": filepath.Join(root, "top")}, "not_dir")
}

func TestListCapAndOffset(t *testing.T) {
	c := dial(t)
	root := t.TempDir()
	const total = 2345
	for i := range total {
		must(t, os.WriteFile(filepath.Join(root, fmt.Sprintf("f%05d", i)), nil, 0o644))
	}
	var seen []string
	for page := 0; ; page++ {
		var list struct {
			Entries   []entry
			Truncated bool
		}
		c.ok("files.list", map[string]any{"path": root, "offset": len(seen)}, &list)
		if len(list.Entries) > 1000 {
			t.Fatalf("page %d has %d entries, over the cap", page, len(list.Entries))
		}
		seen = append(seen, paths(root, list.Entries)...)
		if !list.Truncated {
			break
		}
		if page > 5 {
			t.Fatal("no end to the pages")
		}
	}
	if len(seen) != total || !sort.StringsAreSorted(seen) || seen[0] != "f00000:file" || seen[total-1] != fmt.Sprintf("f%05d:file", total-1) {
		t.Fatalf("pages gave %d entries, want %d in order", len(seen), total)
	}
}

func TestMkdir(t *testing.T) {
	c := dial(t)
	root := t.TempDir()
	var stat entry
	c.ok("files.mkdir", map[string]any{"path": filepath.Join(root, "d"), "mode": 0o700}, nil)
	if c.ok("files.stat", map[string]any{"path": filepath.Join(root, "d")}, &stat); stat.Type != "dir" || stat.Mode != 0o700 {
		t.Fatalf("mkdir %+v", stat)
	}
	c.fails("files.mkdir", map[string]any{"path": filepath.Join(root, "d")}, "exists")
	c.ok("files.mkdir", map[string]any{"path": filepath.Join(root, "x", "y", "z"), "parents": true}, nil)
	c.ok("files.mkdir", map[string]any{"path": filepath.Join(root, "x", "y", "z"), "parents": true}, nil)
	if c.ok("files.stat", map[string]any{"path": filepath.Join(root, "x", "y", "z")}, &stat); stat.Type != "dir" || stat.Mode != 0o755 {
		t.Fatalf("mkdir parents %+v", stat)
	}
	must(t, os.WriteFile(filepath.Join(root, "file"), nil, 0o644))
	c.fails("files.mkdir", map[string]any{"path": filepath.Join(root, "file"), "parents": true}, "exists")
}

func TestMove(t *testing.T) {
	c := dial(t)
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "a"), []byte("A"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "b"), []byte("B"), 0o644))
	must(t, os.MkdirAll(filepath.Join(root, "d", "inner"), 0o755))
	c.ok("files.move", map[string]any{"from": filepath.Join(root, "a"), "to": filepath.Join(root, "c")}, nil)
	if data, err := os.ReadFile(filepath.Join(root, "c")); err != nil || string(data) != "A" {
		t.Fatalf("moved: %q %v", data, err)
	}
	c.fails("files.move", map[string]any{"from": filepath.Join(root, "c"), "to": filepath.Join(root, "b")}, "exists")
	c.ok("files.move", map[string]any{"from": filepath.Join(root, "c"), "to": filepath.Join(root, "b"), "overwrite": true}, nil)
	if data, _ := os.ReadFile(filepath.Join(root, "b")); string(data) != "A" {
		t.Fatalf("overwritten: %q", data)
	}
	c.fails("files.move", map[string]any{"from": filepath.Join(root, "d"), "to": filepath.Join(root, "d", "inner", "d")}, "invalid")
	c.fails("files.move", map[string]any{"from": filepath.Join(root, "b"), "to": filepath.Join(root, "b")}, "invalid")
	c.fails("files.move", map[string]any{"from": filepath.Join(root, "b"), "to": filepath.Join(root, "no", "b")}, "not_found")
	c.ok("files.move", map[string]any{"from": filepath.Join(root, "d"), "to": filepath.Join(root, "e")}, nil)
	if _, err := os.Stat(filepath.Join(root, "e", "inner")); err != nil {
		t.Fatalf("a directory moves whole: %v", err)
	}
}

func TestRemove(t *testing.T) {
	c := dial(t)
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "f"), nil, 0o644))
	must(t, os.MkdirAll(filepath.Join(root, "empty"), 0o755))
	must(t, os.MkdirAll(filepath.Join(root, "full", "sub"), 0o755))
	must(t, os.Symlink(filepath.Join(root, "full"), filepath.Join(root, "link")))
	c.ok("files.remove", map[string]any{"path": filepath.Join(root, "f")}, nil)
	c.ok("files.remove", map[string]any{"path": filepath.Join(root, "empty")}, nil)
	c.ok("files.remove", map[string]any{"path": filepath.Join(root, "link"), "recursive": true}, nil)
	if _, err := os.Stat(filepath.Join(root, "full", "sub")); err != nil {
		t.Fatalf("removing a symlink removed what it points to: %v", err)
	}
	r := c.fails("files.remove", map[string]any{"path": filepath.Join(root, "full")}, "is_dir")
	if !strings.Contains(r.Error.Message, "recursive") {
		t.Fatalf("the message does not say how: %s", r.Error.Message)
	}
	c.ok("files.remove", map[string]any{"path": filepath.Join(root, "full"), "recursive": true}, nil)
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Fatalf("left %v", entries)
	}
	c.fails("files.remove", map[string]any{"path": "/"}, "denied")
}

// pull runs tar.pull and returns the archive, checking each tar.data against the request and the chunk limit.
func pull(t *testing.T, c *conn, path string) []byte {
	t.Helper()
	var res struct{ Bytes int64 }
	notes := c.ok("tar.pull", map[string]any{"path": path}, &res)
	var archive []byte
	for _, n := range notes {
		var data struct {
			Request int
			Data    []byte
		}
		if n.Method != "tar.data" || json.Unmarshal(n.Params, &data) != nil || data.Request != c.nextID {
			t.Fatalf("a notification that is not this pull's tar.data: %s %s", n.Method, n.Params)
		}
		if len(data.Data) == 0 || len(data.Data) > chunk {
			t.Fatalf("a tar.data of %d bytes", len(data.Data))
		}
		archive = append(archive, data.Data...)
	}
	if int64(len(archive)) != res.Bytes {
		t.Fatalf("got %d bytes, the reply says %d", len(archive), res.Bytes)
	}
	return archive
}

// push sends archive to dir in pieces of size and returns the end's reply.
func push(t *testing.T, c *conn, dir string, archive []byte, size int) message {
	t.Helper()
	var begun struct{ ID string }
	c.ok("tar.push.begin", map[string]any{"path": dir}, &begun)
	if begun.ID == "" {
		t.Fatal("no push id")
	}
	for at := 0; at < len(archive); at += size {
		r, _ := c.call("tar.push.write", map[string]any{"id": begun.ID, "data": archive[at:min(at+size, len(archive))]})
		if r.Error != nil {
			return r
		}
	}
	r, _ := c.call("tar.push.end", map[string]any{"id": begun.ID})
	return r
}

// tree describes every entry below root: type, mode, and content or link target.
func tree(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	must(t, filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || p == root {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		row := fmt.Sprintf("%s %s %o", rel, info.Mode().Type(), info.Mode().Perm())
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			target, _ := os.Readlink(p)
			row = fmt.Sprintf("%s %s -> %s", rel, info.Mode().Type(), target)
		case info.Mode().IsRegular():
			data, _ := os.ReadFile(p)
			row += fmt.Sprintf(" %d %x", len(data), data[:min(len(data), 16)])
		}
		out = append(out, row)
		return nil
	}))
	return out
}

func TestTarRoundTrip(t *testing.T) {
	c := dial(t)
	src := filepath.Join(t.TempDir(), "src")
	must(t, os.MkdirAll(filepath.Join(src, "a", "b"), 0o755))
	must(t, os.Mkdir(filepath.Join(src, "private"), 0o700))
	must(t, os.WriteFile(filepath.Join(src, "run.sh"), []byte("#!/bin/sh\necho hi\n"), 0o755))
	must(t, os.WriteFile(filepath.Join(src, "private", "key"), []byte("k"), 0o600))
	must(t, os.WriteFile(filepath.Join(src, "a", "b", "empty"), nil, 0o644))
	big := make([]byte, 1500<<10)
	_, _ = rand.Read(big)
	must(t, os.WriteFile(filepath.Join(src, "a", "big.bin"), big, 0o644))
	must(t, os.Symlink("a/b", filepath.Join(src, "link")))
	archive := pull(t, c, src)
	if len(archive) < len(big) {
		t.Fatalf("the archive is %d bytes", len(archive))
	}
	names := []string{}
	reader := tar.NewReader(bytes.NewReader(archive))
	for {
		hdr, err := reader.Next()
		if err == io.EOF {
			break
		}
		must(t, err)
		names = append(names, hdr.Name)
	}
	if got := strings.Join(names, " "); got != "a/ a/b/ a/b/empty a/big.bin link private/ private/key run.sh" {
		t.Fatalf("entries are relative to the pulled directory: %s", got)
	}
	dst := filepath.Join(t.TempDir(), "made", "dst")
	r := push(t, c, dst, archive, 100<<10)
	var end struct{ Entries int }
	if r.Error != nil || json.Unmarshal(r.Result, &end) != nil || end.Entries != len(names) {
		t.Fatalf("push end %s %+v", r.Result, r.Error)
	}
	if want, got := strings.Join(tree(t, src), "\n"), strings.Join(tree(t, dst), "\n"); want != got {
		t.Fatalf("the tree did not round trip:\n%s\n---\n%s", want, got)
	}
	if data, _ := os.ReadFile(filepath.Join(dst, "a", "big.bin")); !bytes.Equal(data, big) {
		t.Fatal("big.bin differs")
	}
	file := pull(t, c, filepath.Join(src, "run.sh"))
	hdr, err := tar.NewReader(bytes.NewReader(file)).Next()
	if err != nil || hdr.Name != "run.sh" || hdr.Mode&0o777 != 0o755 {
		t.Fatalf("a file pulls as one entry named for it: %+v %v", hdr, err)
	}
}

type tarEntry struct {
	name, link string
	flag       byte
	body       []byte
}

func makeTar(t *testing.T, entries ...tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := tar.NewWriter(&buf)
	for _, e := range entries {
		hdr := &tar.Header{Name: e.name, Linkname: e.link, Typeflag: e.flag, Mode: 0o644, Size: int64(len(e.body))}
		if e.flag == tar.TypeDir {
			hdr.Mode = 0o755
		}
		must(t, w.WriteHeader(hdr))
		_, err := w.Write(e.body)
		must(t, err)
	}
	must(t, w.Close())
	return buf.Bytes()
}

func TestTarPushRefusesEntriesOutsideTheTarget(t *testing.T) {
	c := dial(t)
	base := t.TempDir()
	outside := filepath.Join(base, "outside")
	must(t, os.Mkdir(outside, 0o755))
	for name, archive := range map[string][]byte{
		"dot-dot":         makeTar(t, tarEntry{name: "ok", flag: tar.TypeReg, body: []byte("1")}, tarEntry{name: "../outside/x", flag: tar.TypeReg, body: []byte("x")}),
		"dot-dot inside":  makeTar(t, tarEntry{name: "sub/../../outside/x", flag: tar.TypeReg, body: []byte("x")}),
		"absolute":        makeTar(t, tarEntry{name: outside + "/x", flag: tar.TypeReg, body: []byte("x")}),
		"symlink escape":  makeTar(t, tarEntry{name: "esc", link: outside, flag: tar.TypeSymlink}, tarEntry{name: "esc/x", flag: tar.TypeReg, body: []byte("x")}),
		"relative escape": makeTar(t, tarEntry{name: "esc", link: "../outside", flag: tar.TypeSymlink}, tarEntry{name: "esc/x", flag: tar.TypeDir}),
		"hard link":       makeTar(t, tarEntry{name: "hard", link: outside + "/x", flag: tar.TypeLink}),
	} {
		dst := filepath.Join(base, strings.ReplaceAll(name, " ", "-"))
		r := push(t, c, dst, archive, 1024)
		want := "denied"
		if name == "hard link" {
			want = "invalid"
		}
		if r.Error == nil || r.kind() != want || !strings.Contains(r.Error.Message, "entry") {
			t.Errorf("%s: want %s naming the entry, got %s %+v", name, want, r.Result, r.Error)
		}
		if left, _ := os.ReadDir(outside); len(left) != 0 {
			t.Fatalf("%s: wrote %v outside the target", name, left)
		}
	}
	if _, err := os.Stat(filepath.Join(base, "dot-dot", "ok")); err != nil {
		t.Fatalf("entries before the refused one are kept: %v", err)
	}
}

func TestTarPushEntriesMeetWhatIsThere(t *testing.T) {
	c := dial(t)
	dst := t.TempDir()
	must(t, os.WriteFile(filepath.Join(dst, "was-file"), []byte("old"), 0o644))
	must(t, os.Symlink("/etc/hostname", filepath.Join(dst, "was-link")))
	r := push(t, c, dst, makeTar(t, tarEntry{name: "was-link", flag: tar.TypeReg, body: []byte("new")}), chunk)
	if r.Error != nil {
		t.Fatalf("a file replaces a symlink: %+v", r.Error)
	}
	if info, err := os.Lstat(filepath.Join(dst, "was-link")); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("was-link is %v %v", info, err)
	}
	r = push(t, c, dst, makeTar(t, tarEntry{name: "was-file", flag: tar.TypeDir}), chunk)
	if r.kind() != "exists" {
		t.Fatalf("a dir over a file: %+v", r.Error)
	}
	must(t, os.WriteFile(filepath.Join(dst, "a-file"), nil, 0o644))
	c.fails("tar.push.begin", map[string]any{"path": filepath.Join(dst, "a-file")}, "not_dir")
	r = push(t, c, filepath.Join(dst, "cut"), makeTar(t, tarEntry{name: "f", flag: tar.TypeReg, body: bytes.Repeat([]byte("x"), 5000)})[:2048], chunk)
	if r.kind() != "invalid" {
		t.Fatalf("a cut archive: %+v", r.Error)
	}
}

func TestTarPullCancel(t *testing.T) {
	c := dial(t)
	dir := t.TempDir()
	big := make([]byte, 8<<20)
	_, _ = rand.Read(big)
	must(t, os.WriteFile(filepath.Join(dir, "big"), big, 0o644))
	c.send(41, "tar.pull", map[string]any{"path": dir})
	if first := c.next(); first.Method != "tar.data" {
		t.Fatalf("want tar.data first, got %s %+v", first.Result, first.Error)
	}
	cancel, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "$/cancelRequest", "params": map[string]any{"id": 41}})
	_, err := c.in.Write(append(cancel, '\n'))
	must(t, err)
	chunks := 1
	for {
		m := c.next()
		if m.ID == nil {
			chunks++
			continue
		}
		if string(m.ID) != "41" || m.kind() != "aborted" {
			t.Fatalf("want aborted, got %s %+v", m.Result, m.Error)
		}
		break
	}
	if chunks >= len(big)/chunk {
		t.Fatalf("%d chunks after the cancel: the pull did not stop", chunks)
	}
	var stat entry
	c.ok("files.stat", map[string]any{"path": dir}, &stat)
}

func TestAnAbandonedPushIsCleanedUpWhenTheConnectionEnds(t *testing.T) {
	c := dial(t)
	dst := t.TempDir()
	whole := makeTar(t, tarEntry{name: "done", flag: tar.TypeReg, body: []byte("d")}, tarEntry{name: "half", flag: tar.TypeReg, body: bytes.Repeat([]byte("h"), 1<<20)})
	var begun struct{ ID string }
	c.ok("tar.push.begin", map[string]any{"path": dst}, &begun)
	c.ok("tar.push.write", map[string]any{"id": begun.ID, "data": whole[:300<<10]}, nil)
	_ = c.in.Close()
	select {
	case <-c.served:
	case <-time.After(10 * time.Second):
		t.Fatal("the connection did not end")
	}
	entries, _ := os.ReadDir(dst)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if strings.Join(names, " ") != "done" {
		t.Fatalf("after the connection ended the target holds %v: want only the finished entry, no half file or temp", names)
	}
}

func TestPushesAreBoundedAndPerConnection(t *testing.T) {
	c := dial(t)
	dst := t.TempDir()
	var ids []string
	for range 8 {
		var begun struct{ ID string }
		c.ok("tar.push.begin", map[string]any{"path": dst}, &begun)
		ids = append(ids, begun.ID)
	}
	c.fails("tar.push.begin", map[string]any{"path": dst}, "limit")
	other := dial(t)
	other.fails("tar.push.write", map[string]any{"id": ids[0], "data": ""}, "not_found")
	for _, id := range ids {
		c.ok("tar.push.end", map[string]any{"id": id}, nil)
	}
	c.fails("tar.push.end", map[string]any{"id": ids[0]}, "not_found")
}
