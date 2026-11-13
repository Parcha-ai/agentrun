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
// From e2b-dev/infra@ff3922213f02 packages/shared/pkg/filesystem/entry.go (GetEntryInfoWithResolver, getEntryType,
// getBase), packages/envd/internal/services/filesystem/utils.go (entryInfo) and dir.go (ListDir, followSymlink,
// checkIfDirectory, walkDir). Changed for the open platform: a symlink is reported as one, with its target as written,
// unless the caller follows it; the mode keeps setuid, setgid and sticky; uid and gid are numbers, not looked-up
// names; no xattr metadata; a listing has an offset and stops at an entry and byte cap, saying it was cut.

package files

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

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

type StatParams struct {
	Path   string `json:"path"`
	Follow bool   `json:"follow,omitempty"`
}

type ListParams struct {
	Path   string `json:"path"`
	Depth  *int   `json:"depth,omitempty"`
	Offset int    `json:"offset,omitempty"`
}

type ListResult struct {
	Entries   []Entry `json:"entries"`
	Truncated bool    `json:"truncated"`
}

// entryOf describes info, found at path. A symlink's target is read from path.
func entryOf(path string, info fs.FileInfo) Entry {
	entry := Entry{Type: typeOf(info.Mode()), Size: info.Size(), Mode: uint32(info.Mode().Perm()), MtimeMs: info.ModTime().UnixMilli()}
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		entry.Mode = st.Mode & 0o7777
		entry.UID = st.Uid
		entry.GID = st.Gid
	}
	if entry.Type == "symlink" {
		entry.Target, _ = os.Readlink(path)
	}
	return entry
}

func typeOf(mode fs.FileMode) string {
	switch {
	case mode.IsRegular():
		return "file"
	case mode.IsDir():
		return "dir"
	case mode&fs.ModeSymlink != 0:
		return "symlink"
	default:
		return "other"
	}
}

// Stat describes path; a symlink at path is followed only when follow is set.
func Stat(params StatParams) (Entry, error) {
	path, err := cleanPath("path", params.Path)
	if err != nil {
		return Entry{}, err
	}
	stat := os.Lstat
	if params.Follow {
		stat = os.Stat
	}
	info, err := stat(path)
	if err != nil {
		return Entry{}, fsError(err)
	}
	return entryOf(path, info), nil
}

var errListFull = errors.New("the listing is full")

// List walks the directory at path (following it if it is a symlink) down to depth levels (default 1), in walk order: each
// directory's entries by name, a directory before what it holds. Symlinks below it are listed, never entered. It skips
// offset entries, and stops at MaxListEntries or maxListBytes with Truncated set.
func List(params ListParams) (ListResult, error) {
	path, err := cleanPath("path", params.Path)
	if err != nil {
		return ListResult{}, err
	}
	depth, offset := 1, params.Offset
	if params.Depth != nil {
		depth = *params.Depth
	}
	if depth < 1 || depth > MaxListDepth {
		return ListResult{}, rpc.Errorf(rpc.KindInvalid, "depth must be from 1 to %d", MaxListDepth)
	}
	if offset < 0 {
		return ListResult{}, rpc.Errorf(rpc.KindInvalid, "offset must be 0 or more")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return ListResult{}, fsError(err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return ListResult{}, fsError(err)
	}
	if !info.IsDir() {
		return ListResult{}, rpc.Errorf(rpc.KindNotDir, "%s is not a directory", path)
	}
	result := ListResult{Entries: []Entry{}}
	skipped, budget := 0, maxListBytes
	err = filepath.WalkDir(resolved, func(p string, d fs.DirEntry, walkErr error) error {
		if p == resolved {
			return walkErr
		}
		if walkErr != nil {
			return nil // An unreadable directory stays listed, without what it holds.
		}
		rel, err := filepath.Rel(resolved, p)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return nil // Gone since its directory was read.
		}
		if skipped < offset {
			skipped++
		} else {
			entry := entryOf(p, info)
			entry.Path = filepath.Join(path, rel)
			data, _ := json.Marshal(entry)
			if len(result.Entries) == MaxListEntries || len(data)+1 > budget {
				return errListFull
			}
			budget -= len(data) + 1
			result.Entries = append(result.Entries, entry)
		}
		if d.IsDir() && strings.Count(rel, string(filepath.Separator))+1 >= depth {
			return filepath.SkipDir
		}
		return nil
	})
	if errors.Is(err, errListFull) {
		result.Truncated = true
		err = nil
	}
	if err != nil {
		return ListResult{}, fsError(err)
	}
	return result, nil
}
