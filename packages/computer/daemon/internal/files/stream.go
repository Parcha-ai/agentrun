package files

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

type PullParams struct {
	Path string `json:"path"`
}

type PullResult struct {
	Bytes int64 `json:"bytes"`
}

type PushBeginParams struct {
	Path string `json:"path"`
}

type PushBeginResult struct {
	ID string `json:"id"`
}

type PushWriteParams struct {
	ID   string `json:"id"`
	Data []byte `json:"data"`
}

type PushEndParams struct {
	ID string `json:"id"`
}

type PushEndResult struct {
	Entries int `json:"entries"`
}

// Pull writes the tar of path through send, in chunks of at most MaxChunk bytes, and returns the archive's length. A
// file is one entry, named for it; a directory's entries are named relative to it. path is followed if it is a
// symlink; symlinks below it are archived as links, and sockets, devices and pipes are left out. send blocks while the
// client does not read, so at most one chunk is held. A cancelled ctx stops the pull at the next chunk.
func Pull(ctx context.Context, params PullParams, send func([]byte) error) (PullResult, error) {
	path, err := cleanPath("path", params.Path)
	if err != nil {
		return PullResult{}, err
	}
	root, err := filepath.EvalSymlinks(path)
	if err != nil {
		return PullResult{}, fsError(err)
	}
	info, err := os.Stat(root)
	if err != nil {
		return PullResult{}, fsError(err)
	}
	out := &chunker{ctx: ctx, send: send, buf: make([]byte, 0, MaxChunk)}
	tw := tar.NewWriter(out)
	if info.IsDir() {
		err = filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil || p == root {
				return walkErr
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(root, p)
			if err != nil {
				return err
			}
			return addEntry(tw, p, filepath.ToSlash(rel), info)
		})
	} else {
		err = addEntry(tw, root, filepath.Base(path), info)
	}
	if err == nil {
		err = tw.Close()
	}
	if err == nil {
		err = out.flush()
	}
	if ctx.Err() != nil {
		return PullResult{}, rpc.Errorf(rpc.KindAborted, "the pull of %s was cancelled", path)
	}
	if err != nil {
		return PullResult{}, fsError(err)
	}
	return PullResult{Bytes: out.sent}, nil
}

func addEntry(tw *tar.Writer, path, name string, info fs.FileInfo) error {
	link := ""
	switch {
	case info.Mode().IsRegular(), info.IsDir():
	case info.Mode()&fs.ModeSymlink != 0:
		var err error
		if link, err = os.Readlink(path); err != nil {
			return err
		}
	default:
		return nil
	}
	hdr, err := tar.FileInfoHeader(info, link)
	if err != nil {
		return err
	}
	hdr.Name = name
	if info.IsDir() {
		hdr.Name += "/"
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := io.CopyN(tw, f, hdr.Size); err != nil {
		return fmt.Errorf("%s changed while it was read: %w", path, err)
	}
	return nil
}

// chunker sends what is written to it in chunks of MaxChunk bytes, the last one shorter.
type chunker struct {
	ctx  context.Context
	send func([]byte) error
	buf  []byte
	sent int64
}

func (c *chunker) Write(p []byte) (int, error) {
	n := 0
	for len(p) > 0 {
		take := min(len(p), MaxChunk-len(c.buf))
		c.buf = append(c.buf, p[:take]...)
		p, n = p[take:], n+take
		if len(c.buf) == MaxChunk {
			if err := c.flush(); err != nil {
				return n, err
			}
		}
	}
	return n, nil
}

func (c *chunker) flush() error {
	if len(c.buf) == 0 {
		return nil
	}
	if err := c.ctx.Err(); err != nil {
		return err
	}
	if err := c.send(c.buf); err != nil {
		return err
	}
	c.sent += int64(len(c.buf))
	c.buf = c.buf[:0]
	return nil
}

// Pushes are one connection's open tar pushes. Each extracts, as its bytes come, in a goroutine of its own reading a
// pipe: a write returns once extraction has taken its bytes, so a push holds no more than one write in memory.
type Pushes struct {
	mu   sync.Mutex
	next int
	open map[string]*push
}

type push struct {
	mu      sync.Mutex
	w       *io.PipeWriter
	done    chan struct{}
	entries int
	err     error
}

var errConnectionEnded = errors.New("the connection ended")

func NewPushes() *Pushes { return &Pushes{open: map[string]*push{}} }

// Begin opens a push into a directory, made with its parents when missing.
func (p *Pushes) Begin(params PushBeginParams) (PushBeginResult, error) {
	dir, err := cleanPath("path", params.Path)
	if err != nil {
		return PushBeginResult{}, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.open) >= MaxPushes {
		return PushBeginResult{}, rpc.Errorf(rpc.KindLimit, "a connection has at most %d pushes open: end one first", MaxPushes)
	}
	if info, err := os.Stat(dir); err == nil && !info.IsDir() {
		return PushBeginResult{}, rpc.Errorf(rpc.KindNotDir, "%s is not a directory", dir)
	}
	if err := makeDirectory(dir, 0o755, true); err != nil {
		return PushBeginResult{}, err
	}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return PushBeginResult{}, fsError(err)
	}
	r, w := io.Pipe()
	one := &push{w: w, done: make(chan struct{})}
	go func() {
		defer close(one.done)
		one.entries, one.err = extractTar(r, root)
		if one.err == nil {
			_, _ = io.Copy(io.Discard, r) // What follows the archive's end, until the push ends.
		}
		_ = r.CloseWithError(one.err)
	}()
	p.next++
	id := fmt.Sprintf("push-%d", p.next)
	p.open[id] = one
	return PushBeginResult{ID: id}, nil
}

func (p *Pushes) take(id string, drop bool) (*push, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	one, ok := p.open[id]
	if !ok {
		return nil, rpc.Errorf(rpc.KindNotFound, "no push %q on this connection: it ended, failed, or was never begun", id)
	}
	if drop {
		delete(p.open, id)
	}
	return one, nil
}

// Write hands data to the push's extraction. When extraction has failed, the push ends with its error.
func (p *Pushes) Write(params PushWriteParams) (Empty, error) {
	one, err := p.take(params.ID, false)
	if err != nil {
		return Empty{}, err
	}
	one.mu.Lock()
	defer one.mu.Unlock()
	if _, err := one.w.Write(params.Data); err != nil {
		_, _ = p.take(params.ID, true)
		<-one.done
		if one.err != nil {
			return Empty{}, one.err
		}
		return Empty{}, rpc.Errorf(rpc.KindInvalid, "push %s ended: %v", params.ID, err)
	}
	return Empty{}, nil
}

// End closes the push's input and waits for its extraction.
func (p *Pushes) End(params PushEndParams) (PushEndResult, error) {
	one, err := p.take(params.ID, true)
	if err != nil {
		return PushEndResult{}, err
	}
	one.mu.Lock()
	defer one.mu.Unlock()
	_ = one.w.Close()
	<-one.done
	if one.err != nil {
		return PushEndResult{}, one.err
	}
	return PushEndResult{Entries: one.entries}, nil
}

// Close ends every push still open, when the connection ends: each extraction stops, and removes the file it was
// writing.
func (p *Pushes) Close() error {
	p.mu.Lock()
	open := p.open
	p.open = map[string]*push{}
	p.mu.Unlock()
	for _, one := range open {
		_ = one.w.CloseWithError(errConnectionEnded)
		<-one.done
	}
	return nil
}
