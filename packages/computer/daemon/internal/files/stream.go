package files

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

type PullBeginParams struct {
	Path string `json:"path"`
}

type PullBeginResult struct {
	ID string `json:"id"`
}

type PullReadParams struct {
	ID       string `json:"id"`
	MaxBytes *int   `json:"maxBytes,omitempty"`
}

type PullReadResult struct {
	Data []byte `json:"data"`
	EOF  bool   `json:"eof"`
}

type PullEndParams struct {
	ID string `json:"id"`
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

// Pulls are one connection's open tar pulls. Each writes its archive into a pipe from a goroutine of its own, so it
// holds no more than what one read takes, and stops when the pull ends.
type Pulls struct {
	mu   sync.Mutex
	next int
	open map[string]*pull
}

type pull struct {
	mu   sync.Mutex
	r    *io.PipeReader
	done chan struct{}
}

func NewPulls() *Pulls { return &Pulls{open: map[string]*pull{}} }

// Begin opens a pull of the tar of path. A file is one entry, named for it; a directory's entries are named relative
// to it. path is followed if it is a symlink; symlinks below it are archived as links, and sockets, devices and pipes
// are left out.
func (p *Pulls) Begin(params PullBeginParams) (PullBeginResult, error) {
	path, err := cleanPath("path", params.Path)
	if err != nil {
		return PullBeginResult{}, err
	}
	root, err := filepath.EvalSymlinks(path)
	if err != nil {
		return PullBeginResult{}, fsError(err)
	}
	info, err := os.Stat(root)
	if err != nil {
		return PullBeginResult{}, fsError(err)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.open) >= MaxPulls {
		return PullBeginResult{}, rpc.Errorf(rpc.KindLimit, "a connection has at most %d pulls open: end one first", MaxPulls)
	}
	r, w := io.Pipe()
	one := &pull{r: r, done: make(chan struct{})}
	go func() {
		defer close(one.done)
		_ = w.CloseWithError(writeTar(w, root, filepath.Base(path), info))
	}()
	p.next++
	id := fmt.Sprintf("pull-%d", p.next)
	p.open[id] = one
	return PullBeginResult{ID: id}, nil
}

// Read returns the archive's next maxBytes (default and most MaxChunk): fewer only at its end, which eof marks.
func (p *Pulls) Read(params PullReadParams) (PullReadResult, error) {
	size := MaxChunk
	if params.MaxBytes != nil {
		size = *params.MaxBytes
	}
	if size < 1 {
		return PullReadResult{}, rpc.Errorf(rpc.KindInvalid, "maxBytes must be 1 or more")
	}
	if size > MaxChunk {
		return PullReadResult{}, rpc.Errorf(rpc.KindLimit, "a tar.pull.read returns at most %d bytes", MaxChunk)
	}
	p.mu.Lock()
	one, ok := p.open[params.ID]
	p.mu.Unlock()
	if !ok {
		return PullReadResult{}, rpc.Errorf(rpc.KindNotFound, "no pull %q on this connection: it ended, or was never begun", params.ID)
	}
	one.mu.Lock()
	defer one.mu.Unlock()
	data := make([]byte, size)
	n, err := io.ReadFull(one.r, data)
	switch {
	case err == nil:
		return PullReadResult{Data: data, EOF: false}, nil
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return PullReadResult{Data: data[:n], EOF: true}, nil
	case errors.Is(err, io.ErrClosedPipe):
		return PullReadResult{}, rpc.Errorf(rpc.KindNotFound, "pull %s ended while it was read", params.ID)
	default:
		return PullReadResult{}, fsError(err)
	}
}

// End stops the pull and frees it. Ending a pull that is not open is fine.
func (p *Pulls) End(params PullEndParams) (Empty, error) {
	p.mu.Lock()
	one, ok := p.open[params.ID]
	delete(p.open, params.ID)
	p.mu.Unlock()
	if ok {
		one.stop()
	}
	return Empty{}, nil
}

// Close ends every pull still open, when the connection ends.
func (p *Pulls) Close() error {
	p.mu.Lock()
	open := p.open
	p.open = map[string]*pull{}
	p.mu.Unlock()
	for _, one := range open {
		one.stop()
	}
	return nil
}

// stop fails the writer's next write and the reader's wait, then waits for the writer to return.
func (one *pull) stop() {
	_ = one.r.Close()
	<-one.done
}

// writeTar writes the tar of root, found at info, to w: a directory's entries relative to it, else one entry, name.
func writeTar(w io.Writer, root, name string, info fs.FileInfo) error {
	tw := tar.NewWriter(w)
	var err error
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
		err = addEntry(tw, root, name, info)
	}
	if err != nil {
		return err
	}
	return tw.Close()
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
