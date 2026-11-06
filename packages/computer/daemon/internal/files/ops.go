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
// From kubernetes-sigs/agent-sandbox@bfc8505 packages/sandboxd/pkg/server/filesystem.go (writeFSError,
// writeMakeDirectoryError, makeDirectory, handleDeleteFile, handleFileAction, isWithin) and e2b-dev/infra@ff3922213f02
// packages/envd/internal/services/filesystem/move.go (Move). Changed for the open platform: errors are the protocol's
// kinds instead of HTTP statuses or Connect codes; a directory already there fails mkdir unless parents is set; move
// makes no missing parent, replaces as rename(2) does only with overwrite, and otherwise never replaces (renameat2 with
// RENAME_NOREPLACE); there is no sandbox root to confine to or clear, and the filesystem root is never removed.

package files

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// fsError maps a filesystem error to the protocol's kind, keeping the error's words (the call and the path).
func fsError(err error) error {
	var e *rpc.Error
	if errors.As(err, &e) {
		return e
	}
	kind := rpc.KindInvalid
	switch {
	case errors.Is(err, fs.ErrNotExist):
		kind = rpc.KindNotFound
	case errors.Is(err, fs.ErrPermission), errors.Is(err, syscall.EROFS):
		kind = rpc.KindDenied
	case errors.Is(err, fs.ErrExist):
		kind = rpc.KindExists
	case errors.Is(err, syscall.ENOTDIR):
		kind = rpc.KindNotDir
	case errors.Is(err, syscall.EISDIR):
		kind = rpc.KindIsDir
	case errors.Is(err, syscall.EXDEV):
		kind = rpc.KindUnsupported
	case errors.Is(err, syscall.ENOSPC), errors.Is(err, syscall.EDQUOT), errors.Is(err, syscall.EFBIG):
		kind = rpc.KindLimit
	}
	return rpc.Errorf(kind, "%s", err.Error())
}

type MkdirParams struct {
	Path    string  `json:"path"`
	Parents bool    `json:"parents,omitempty"`
	Mode    *uint32 `json:"mode,omitempty"`
}

type MoveParams struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Overwrite bool   `json:"overwrite,omitempty"`
}

type RemoveParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive,omitempty"`
}

// Mkdir makes a directory with exactly mode (default 0755), whatever the umask. With parents, missing parents are made and a
// directory already there is fine.
func Mkdir(params MkdirParams) (Empty, error) {
	path, err := cleanPath("path", params.Path)
	if err != nil {
		return Empty{}, err
	}
	perm, err := mode(params.Mode, 0o755)
	if err != nil {
		return Empty{}, err
	}
	return Empty{}, makeDirectory(path, perm, params.Parents)
}

func makeDirectory(target string, perm os.FileMode, parents bool) error {
	if parents {
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fsError(err)
		}
	}
	err := os.Mkdir(target, perm)
	if errors.Is(err, fs.ErrExist) {
		if info, statErr := os.Stat(target); parents && statErr == nil && info.IsDir() {
			return nil
		}
	}
	if err != nil {
		return fsError(err)
	}
	if err := os.Chmod(target, perm); err != nil {
		return fsError(err)
	}
	return nil
}

// Move renames from to to. A symlink at from is moved, not followed. What is at to is replaced only with overwrite.
func Move(params MoveParams) (Empty, error) {
	from, err := cleanPath("from", params.From)
	if err != nil {
		return Empty{}, err
	}
	to, err := cleanPath("to", params.To)
	if err != nil {
		return Empty{}, err
	}
	if from == to {
		return Empty{}, rpc.Errorf(rpc.KindInvalid, "from and to are the same path")
	}
	src, err := os.Lstat(from)
	if err != nil {
		return Empty{}, fsError(err)
	}
	if src.IsDir() && isWithin(from, to) {
		return Empty{}, rpc.Errorf(rpc.KindInvalid, "cannot move %s into itself", from)
	}
	if params.Overwrite {
		err = os.Rename(from, to)
	} else {
		err = renameNoReplace(from, to, src.IsDir())
	}
	switch {
	case err == nil:
		return Empty{}, nil
	case errors.Is(err, syscall.EEXIST):
		return Empty{}, rpc.Errorf(rpc.KindExists, "%s exists: pass overwrite to replace it", to)
	case errors.Is(err, syscall.EXDEV):
		return Empty{}, rpc.Errorf(rpc.KindUnsupported, "cannot move %s to %s across filesystems: copy it, then remove it", from, to)
	}
	return Empty{}, fsError(err)
}

// renameNoReplace renames from to to only if nothing is at to, in one step: renameat2 with RENAME_NOREPLACE. Where the
// kernel or filesystem lacks it, a file is linked to its new name (which fails if one is there) and its old name
// removed; a directory, which cannot be linked, is refused.
func renameNoReplace(from, to string, isDir bool) error {
	err := renameat2(from, to, renameNoReplaceFlag)
	if !errors.Is(err, syscall.EINVAL) && !errors.Is(err, syscall.ENOSYS) {
		return err
	}
	if isDir {
		return rpc.Errorf(rpc.KindUnsupported, "cannot move the directory %s without overwrite: this filesystem cannot rename without replacing; pass overwrite", from)
	}
	return linkMove(from, to)
}

const renameNoReplaceFlag = 1 // RENAME_NOREPLACE

func renameat2(from, to string, flags uintptr) error {
	fromPtr, err := syscall.BytePtrFromString(from)
	if err != nil {
		return err
	}
	toPtr, err := syscall.BytePtrFromString(to)
	if err != nil {
		return err
	}
	cwd := -100 // AT_FDCWD
	atCwd := uintptr(cwd)
	_, _, errno := syscall.Syscall6(sysRenameat2, atCwd, uintptr(unsafe.Pointer(fromPtr)), atCwd, uintptr(unsafe.Pointer(toPtr)), flags, 0)
	if errno != 0 {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: errno}
	}
	return nil
}

// linkMove moves a file that is not a directory by a hard link and the removal of its old name.
func linkMove(from, to string) error {
	if err := os.Link(from, to); err != nil {
		return err
	}
	return os.Remove(from)
}

func isWithin(dir, path string) bool {
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// Remove removes a file, a symlink (never what it points to) or an empty directory; with recursive, a directory and
// everything in it.
func Remove(params RemoveParams) (Empty, error) {
	path, err := cleanPath("path", params.Path)
	if err != nil {
		return Empty{}, err
	}
	if path == string(filepath.Separator) {
		return Empty{}, rpc.Errorf(rpc.KindDenied, "the filesystem root is never removed")
	}
	if _, err := os.Lstat(path); err != nil {
		return Empty{}, fsError(err)
	}
	if params.Recursive {
		err = os.RemoveAll(path)
	} else {
		err = os.Remove(path)
	}
	if errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EEXIST) {
		return Empty{}, rpc.Errorf(rpc.KindIsDir, "%s is a directory with entries: pass recursive to remove it all", path)
	}
	if err != nil {
		return Empty{}, fsError(err)
	}
	return Empty{}, nil
}
