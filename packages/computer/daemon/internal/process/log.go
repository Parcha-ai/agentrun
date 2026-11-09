package process

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// logFile is a process's log: a new file the daemon made, which it writes the first bytes of the output to and reads
// back through the same open file, never by path again. What a program does to the path afterwards (a rename, a
// removal, a link put in its place) changes nothing the daemon reads or writes.
type logFile struct {
	file *os.File
	// dir and name undo a start that fails after the file was made: unlinkat in the directory the file was made in.
	dir  int
	name string
	max  int64

	mu      sync.Mutex
	written int64
	capped  bool
	// failed is why the log stopped at its first failed or short write; nothing is written after it, so the file stays
	// a true prefix of the output.
	failed string
}

// openLog makes the file at path, and every missing directory on its way, without following a link: each directory is
// entered from the one above it with O_NOFOLLOW|O_DIRECTORY, and the file is made with O_CREAT|O_EXCL|O_NOFOLLOW, so a
// link planted at the path or at any directory on its way, or a file already there, is refused and nothing is written.
// The file is the daemon's, mode 0644.
func openLog(path string, max int64) (*logFile, error) {
	if !filepath.IsAbs(path) {
		return nil, rpc.Errorf(rpc.KindInvalid, "log %q is not an absolute path", path)
	}
	clean := filepath.Clean(path)
	if clean == "/" {
		return nil, rpc.Errorf(rpc.KindInvalid, "log %q names no file", path)
	}
	dir, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, rpc.Errorf(rpc.KindDenied, "cannot open / for the log: %v", err)
	}
	parts := strings.Split(strings.TrimPrefix(clean, "/"), "/")
	at := ""
	for _, name := range parts[:len(parts)-1] {
		at += "/" + name
		if err := syscall.Mkdirat(dir, name, 0o755); err != nil && !errors.Is(err, syscall.EEXIST) {
			_ = syscall.Close(dir)
			return nil, logRefused(at, err)
		}
		next, err := syscall.Openat(dir, name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		_ = syscall.Close(dir)
		if err != nil {
			return nil, logRefused(at, err)
		}
		dir = next
	}
	name := parts[len(parts)-1]
	fd, err := syscall.Openat(dir, name, syscall.O_RDWR|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o644)
	if err != nil {
		// O_EXCL meets a link at the name as EEXIST: say which it is, never following it.
		var st syscall.Stat_t
		if errors.Is(err, syscall.EEXIST) && fstatatNoFollow(dir, name, &st) == nil && st.Mode&syscall.S_IFMT == syscall.S_IFLNK {
			err = syscall.ELOOP
		}
		_ = syscall.Close(dir)
		return nil, logRefused(clean, err)
	}
	if err := syscall.Fchmod(fd, 0o644); err != nil {
		_ = syscall.Close(fd)
		_ = syscall.Unlinkat(dir, name)
		_ = syscall.Close(dir)
		return nil, rpc.Errorf(rpc.KindDenied, "cannot make log %s mode 644: %v", clean, err)
	}
	return &logFile{file: os.NewFile(uintptr(fd), clean), dir: dir, name: name, max: max}, nil
}

// fstatatNoFollow stats name in dir, a link itself and not what it names: opened with O_PATH|O_NOFOLLOW, then fstat.
func fstatatNoFollow(dir int, name string, st *syscall.Stat_t) error {
	fd, err := syscall.Openat(dir, name, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	return syscall.Fstat(fd, st)
}

// oPath is O_PATH, which the syscall package lacks on amd64.
const oPath = 0x200000

// logRefused says why the log could not be made at path.
func logRefused(path string, err error) error {
	switch {
	case errors.Is(err, syscall.ELOOP):
		return rpc.Errorf(rpc.KindDenied, "%s is a link: a log is never written through one", path)
	case errors.Is(err, syscall.EEXIST):
		return rpc.Errorf(rpc.KindExists, "%s exists: a log is a new file", path)
	case errors.Is(err, syscall.ENOTDIR):
		// O_NOFOLLOW|O_DIRECTORY on a link to a directory fails with ENOTDIR, as on a file: neither is entered.
		return rpc.Errorf(rpc.KindDenied, "%s is a link or a file, not a directory: a log is never written through one", path)
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM), errors.Is(err, syscall.EROFS):
		return rpc.Errorf(rpc.KindDenied, "cannot make the log at %s: %v", path, err)
	default:
		return rpc.Errorf(rpc.KindInvalid, "cannot make the log at %s: %v", path, err)
	}
}

// settle lets go of the directory the file was made in, once the start it belongs to has run.
func (l *logFile) settle() {
	if l.dir >= 0 {
		_ = syscall.Close(l.dir)
		l.dir = -1
	}
}

// discard removes the file, made for a start that failed, and lets go of it.
func (l *logFile) discard() {
	_ = l.file.Close()
	if l.dir >= 0 {
		_ = syscall.Unlinkat(l.dir, l.name)
	}
	l.settle()
}

// write keeps the first max bytes of the output in the file; past that it marks the log capped. A write that fails or
// writes short stops the log for good: what it wrote stays, nothing after it is written (a later write would land past
// a gap no reader could see), and failed says why.
func (l *logFile) write(p []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.failed != "" {
		return
	}
	if room := l.max - l.written; int64(len(p)) > room {
		p, l.capped = p[:max(room, 0)], true
	}
	if len(p) == 0 {
		return
	}
	n, err := logWriteAt(l.file, p, l.written)
	l.written += int64(max(n, 0))
	switch {
	case err != nil:
		l.failed = fmt.Sprintf("the log stopped at byte %d: %v", l.written, err)
	case n < len(p):
		l.failed = fmt.Sprintf("the log stopped at byte %d: it wrote %d of %d bytes", l.written, n, len(p))
	}
}

// logWriteAt writes a log's bytes; a test swaps it to fail a write.
var logWriteAt = (*os.File).WriteAt

// state is how many bytes the log holds, whether output was dropped past its cap, and why it stopped, if a write failed.
func (l *logFile) state() (written int64, capped bool, failed string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.written, l.capped, l.failed
}

// read reads at most n bytes from offset, through the daemon's own open file. A file the program cut short reads
// short.
func (l *logFile) read(offset int64, n int) []byte {
	data := make([]byte, n)
	got, _ := l.file.ReadAt(data, offset)
	return data[:got]
}

// close lets go of the file, once the process is dropped from the table (or its start failed: discard then removes it).
func (l *logFile) close() {
	_ = l.file.Close()
}
