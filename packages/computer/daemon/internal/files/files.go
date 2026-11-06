// Package files reads, writes, lists and moves files for the daemon's files.* and tar.* methods. Every path it takes
// is absolute and clean (cleanPath makes it so); it acts as the daemon's own user.
package files

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

const (
	// MaxChunk is the most bytes one files.read returns and one tar.data carries: in base64, it fits a line.
	MaxChunk = 512 << 10
	// MaxListDepth is the deepest files.list walks.
	MaxListDepth = 16
	// MaxListEntries is the most entries one files.list returns.
	MaxListEntries = 1000
	// MaxPushes is how many tar pushes one connection may have open.
	MaxPushes = 8
	// maxListBytes keeps a files.list reply, in JSON, well inside a line.
	maxListBytes = 768 << 10
)

type ReadParams struct {
	Path   string `json:"path"`
	Offset int64  `json:"offset,omitempty"`
	Length *int   `json:"length,omitempty"`
}

type ReadResult struct {
	Data []byte `json:"data"`
	EOF  bool   `json:"eof"`
	Size int64  `json:"size"`
}

type WriteParams struct {
	Path    string  `json:"path"`
	Data    []byte  `json:"data"`
	Offset  *int64  `json:"offset,omitempty"`
	Append  bool    `json:"append,omitempty"`
	Mode    *uint32 `json:"mode,omitempty"`
	Parents bool    `json:"parents,omitempty"`
}

type WriteResult struct {
	Size int64 `json:"size"`
}

// Empty is the result of a method that answers only that it is done.
type Empty struct{}

// cleanPath checks a path from a request: absolute, with no NUL, and returned clean.
func cleanPath(field, path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", rpc.Errorf(rpc.KindInvalid, "%s must be an absolute path, not %q", field, path)
	}
	if strings.ContainsRune(path, 0) {
		return "", rpc.Errorf(rpc.KindInvalid, "%s has a NUL byte", field)
	}
	return filepath.Clean(path), nil
}

func mode(given *uint32, otherwise os.FileMode) (os.FileMode, error) {
	if given == nil {
		return otherwise, nil
	}
	if *given > 0o7777 {
		return 0, rpc.Errorf(rpc.KindInvalid, "mode %o has bits beyond 07777", *given)
	}
	m := os.FileMode(*given & 0o777)
	if *given&0o4000 != 0 {
		m |= os.ModeSetuid
	}
	if *given&0o2000 != 0 {
		m |= os.ModeSetgid
	}
	if *given&0o1000 != 0 {
		m |= os.ModeSticky
	}
	return m, nil
}

// Read reads up to length bytes (default MaxChunk) of a regular file at offset. eof says the read reached the end.
func Read(params ReadParams) (ReadResult, error) {
	path, err := cleanPath("path", params.Path)
	if err != nil {
		return ReadResult{}, err
	}
	offset, length := params.Offset, MaxChunk
	if params.Length != nil {
		length = *params.Length
	}
	if offset < 0 {
		return ReadResult{}, rpc.Errorf(rpc.KindInvalid, "offset must be 0 or more")
	}
	if length < 1 {
		return ReadResult{}, rpc.Errorf(rpc.KindInvalid, "length must be 1 or more")
	}
	if length > MaxChunk {
		return ReadResult{}, rpc.Errorf(rpc.KindLimit, "a files.read returns at most %d bytes: read again from offset + the bytes read", MaxChunk)
	}
	info, err := os.Stat(path)
	if err != nil {
		return ReadResult{}, fsError(err)
	}
	if info.IsDir() {
		return ReadResult{}, rpc.Errorf(rpc.KindIsDir, "%s is a directory", path)
	}
	if !info.Mode().IsRegular() {
		return ReadResult{}, rpc.Errorf(rpc.KindInvalid, "%s is not a regular file", path)
	}
	f, err := os.Open(path)
	if err != nil {
		return ReadResult{}, fsError(err)
	}
	defer f.Close()
	data := make([]byte, length)
	n, readErr := f.ReadAt(data, offset)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return ReadResult{}, fsError(readErr)
	}
	if info, err = f.Stat(); err != nil {
		return ReadResult{}, fsError(err)
	}
	eof := n < length || offset+int64(n) >= info.Size()
	return ReadResult{Data: data[:n], EOF: eof, Size: info.Size()}, nil
}

// Write writes a file, made if missing: the whole file, or at an offset, or appended. A mode given is set, created or
// not; a new file without one gets 0644.
func Write(spec WriteParams) (WriteResult, error) {
	path, err := cleanPath("path", spec.Path)
	if err != nil {
		return WriteResult{}, err
	}
	if spec.Offset != nil && spec.Append {
		return WriteResult{}, rpc.Errorf(rpc.KindInvalid, "offset and append cannot both be given")
	}
	if spec.Offset != nil && *spec.Offset < 0 {
		return WriteResult{}, rpc.Errorf(rpc.KindInvalid, "offset must be 0 or more")
	}
	perm, err := mode(spec.Mode, 0o644)
	if err != nil {
		return WriteResult{}, err
	}
	if spec.Parents {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return WriteResult{}, fsError(err)
		}
	}
	if info, err := os.Stat(path); err == nil && !info.Mode().IsRegular() && !info.IsDir() {
		return WriteResult{}, rpc.Errorf(rpc.KindInvalid, "%s is not a regular file", path)
	}
	flags := os.O_WRONLY
	switch {
	case spec.Append:
		flags |= os.O_APPEND
	case spec.Offset == nil:
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(path, flags|os.O_CREATE|os.O_EXCL, perm)
	created := err == nil
	if errors.Is(err, os.ErrExist) {
		f, err = os.OpenFile(path, flags, 0)
		if errors.Is(err, os.ErrNotExist) {
			// A dangling symlink (O_EXCL never follows one): make the file it names, as a new file.
			f, err = os.OpenFile(path, flags|os.O_CREATE, perm)
			created = err == nil
		}
	}
	if err != nil {
		return WriteResult{}, fsError(err)
	}
	defer f.Close()
	if created || spec.Mode != nil {
		if err := f.Chmod(perm); err != nil {
			return WriteResult{}, fsError(err)
		}
	}
	if spec.Offset != nil {
		_, err = f.WriteAt(spec.Data, *spec.Offset)
	} else {
		_, err = f.Write(spec.Data)
	}
	if err != nil {
		return WriteResult{}, fsError(err)
	}
	info, err := f.Stat()
	if err != nil {
		return WriteResult{}, fsError(err)
	}
	if err := f.Close(); err != nil {
		return WriteResult{}, fsError(err)
	}
	return WriteResult{Size: info.Size()}, nil
}
