// Package files reads, writes, lists and moves files for the daemon's files.* and tar.* methods.
package files

import (
	"context"

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
)

type ReadResult struct {
	Data []byte `json:"data"`
	EOF  bool   `json:"eof"`
	Size int64  `json:"size"`
}

type WriteSpec struct {
	Data    []byte
	Offset  *int64
	Append  bool
	Mode    *uint32
	Parents bool
}

type WriteResult struct {
	Size int64 `json:"size"`
}

// Entry is what files.stat answers, and each row of files.list (with the path).
type Entry struct {
	Path    string `json:"path,omitempty"`
	Type    string `json:"type"`
	Size    int64  `json:"size"`
	Mode    uint32 `json:"mode"`
	MtimeMs int64  `json:"mtimeMs"`
	UID     uint32 `json:"uid"`
	GID     uint32 `json:"gid"`
	Target  string `json:"target,omitempty"`
}

type ListResult struct {
	Entries   []Entry `json:"entries"`
	Truncated bool    `json:"truncated"`
}

func notBuilt() error { return rpc.Errorf(rpc.KindUnsupported, "files are not built yet") }

func Path(field, path string) (string, error)                        { return "", notBuilt() }
func Read(path string, offset int64, length int) (ReadResult, error) { return ReadResult{}, notBuilt() }
func Write(path string, spec WriteSpec) (WriteResult, error)         { return WriteResult{}, notBuilt() }
func Stat(path string, follow bool) (Entry, error)                   { return Entry{}, notBuilt() }
func List(path string, depth, offset int) (ListResult, error)        { return ListResult{}, notBuilt() }
func Mkdir(path string, parents bool, mode *uint32) error            { return notBuilt() }
func Move(from, to string, overwrite bool) error                     { return notBuilt() }
func Remove(path string, recursive bool) error                       { return notBuilt() }

func Pull(ctx context.Context, path string, send func([]byte) error) (int64, error) {
	return 0, notBuilt()
}

// Pushes are a connection's open tar pushes.
type Pushes struct{}

func NewPushes() *Pushes                             { return &Pushes{} }
func (p *Pushes) Begin(dir string) (string, error)   { return "", notBuilt() }
func (p *Pushes) Write(id string, data []byte) error { return notBuilt() }
func (p *Pushes) End(id string) (int, error)         { return 0, notBuilt() }
func (p *Pushes) Close() error                       { return nil }
