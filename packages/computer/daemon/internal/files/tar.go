// Copyright 2026 The Kubernetes Authors.
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
// From kubernetes-sigs/agent-sandbox@bfc8505 packages/sandboxd/pkg/server/filesystem.go (extractTar, extractEntry,
// replaceSymlink, writeViaTemp, writeExtractError) and packages/sandboxd/pkg/pathutil/sandbox.go (SanitizePath,
// dirPrefix). Changed for the open platform: the target directory is the root entries are confined to; an entry that is
// absolute or has a ".." part is refused before it is cleaned; a dangling symlink on the way to an entry is refused
// instead of resolved lexically; no gzip and no entry or byte cap (the disk is the limit); no fsync per file; the
// count of entries written is returned; errors are the protocol's kinds, naming the entry.

package files

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// tmpPattern names the temporary files extraction makes beside a target.
const tmpPattern = ".computerd-tmp-*"

// extractTar writes the entries of the tar stream src below dir, which is absolute and resolved, and returns how many
// it wrote. It is not atomic: on an error, the entries written so far stay.
func extractTar(src io.Reader, dir string) (int, error) {
	tr := tar.NewReader(src)
	entries := 0
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return entries, nil
		}
		if err != nil {
			return entries, rpc.Errorf(rpc.KindInvalid, "the archive cannot be read after %d entries: %v", entries, err)
		}
		wrote, err := extractEntry(tr, hdr, dir)
		if err != nil {
			return entries, err
		}
		if wrote {
			entries++
		}
	}
}

// extractEntry writes one entry below dir: a regular file, a directory or a symlink. Hard links, which could alias a
// file outside dir, and devices and pipes are refused.
func extractEntry(body io.Reader, hdr *tar.Header, dir string) (bool, error) {
	if hdr.Typeflag == tar.TypeXGlobalHeader {
		return false, nil // git archive writes one that carries the commit id.
	}
	switch hdr.Typeflag {
	case tar.TypeDir, tar.TypeReg, tar.TypeSymlink:
	default:
		return false, rpc.Errorf(rpc.KindInvalid, "entry %q has type %q: a push makes only files, directories and symlinks", hdr.Name, hdr.Typeflag)
	}
	if filepath.IsAbs(hdr.Name) || slices.Contains(strings.Split(filepath.ToSlash(hdr.Name), "/"), "..") {
		return false, escapes(hdr.Name)
	}
	name := filepath.Clean(filepath.FromSlash(hdr.Name))
	if name == "." {
		return false, nil
	}
	// Resolve only the parent, so a symlink at the entry's own path is replaced, never followed. Resolving the parent
	// also stops an entry from writing through a symlink an earlier entry planted.
	parent, err := sanitizePath(dir, filepath.Dir(name))
	if err != nil {
		if errors.Is(err, errEscapes) {
			return false, escapes(hdr.Name)
		}
		return false, fsError(err)
	}
	leaf := filepath.Join(parent, filepath.Base(name))
	isDir := hdr.Typeflag == tar.TypeDir
	if existing, err := os.Lstat(leaf); err == nil && existing.IsDir() != isDir {
		return false, rpc.Errorf(rpc.KindExists, "entry %q meets a %s already there", hdr.Name, typeOf(existing.Mode()))
	}
	perm := hdr.FileInfo().Mode().Perm()
	switch hdr.Typeflag {
	case tar.TypeDir:
		return true, makeDirectory(leaf, perm|0o700, true)
	case tar.TypeReg:
		return true, writeViaTemp(leaf, body, perm)
	default:
		return true, replaceSymlink(leaf, hdr.Linkname)
	}
}

var errEscapes = errors.New("the path leaves the target directory")

func escapes(name string) error {
	return rpc.Errorf(rpc.KindDenied, "entry %q is outside the target directory", name)
}

// sanitizePath joins rel onto root (absolute and resolved) and resolves its symlinks, or those of its nearest existing
// ancestor when it does not exist yet, re-attaching the rest lexically. A result outside root is errEscapes.
func sanitizePath(root, rel string) (string, error) {
	joined := filepath.Join(root, rel)
	resolved, err := filepath.EvalSymlinks(joined)
	if err != nil {
		if !os.IsNotExist(err) {
			return "", err
		}
		ancestor := joined
		var suffix []string
		for {
			if _, err := os.Lstat(ancestor); err == nil {
				return "", errEscapes // A dangling symlink: where it would lead is not known.
			}
			suffix = append([]string{filepath.Base(ancestor)}, suffix...)
			ancestor = filepath.Dir(ancestor)
			resolvedAncestor, err := filepath.EvalSymlinks(ancestor)
			if err == nil {
				resolved = filepath.Join(append([]string{resolvedAncestor}, suffix...)...)
				break
			}
			if !os.IsNotExist(err) {
				return "", err
			}
			if ancestor == filepath.Dir(ancestor) {
				return "", errEscapes
			}
		}
	}
	if resolved != root && !strings.HasPrefix(resolved, dirPrefix(root)) {
		return "", errEscapes
	}
	return resolved, nil
}

// dirPrefix is dir with one trailing separator, the prefix of every path strictly inside it.
func dirPrefix(dir string) string {
	if strings.HasSuffix(dir, string(os.PathSeparator)) {
		return dir
	}
	return dir + string(os.PathSeparator)
}

// writeViaTemp writes src to a temporary file beside target, then renames it over target. On any failure, the
// connection's end included, the temporary file is removed.
func writeViaTemp(target string, src io.Reader, perm os.FileMode) (err error) {
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fsError(err)
	}
	tmp, err := os.CreateTemp(dir, tmpPattern)
	if err != nil {
		return fsError(err)
	}
	defer func() {
		if err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}
	}()
	if err = tmp.Chmod(perm); err != nil {
		return fsError(err)
	}
	if _, err = io.Copy(tmp, src); err != nil {
		var written *fs.PathError
		if errors.As(err, &written) {
			return fsError(err)
		}
		return rpc.Errorf(rpc.KindInvalid, "the archive cannot be read in %s: %v", filepath.Base(target), err)
	}
	if err = tmp.Close(); err != nil {
		return fsError(err)
	}
	if err = os.Rename(tmp.Name(), target); err != nil {
		return fsError(err)
	}
	return nil
}

// replaceSymlink makes link a symlink to target, replacing a file or symlink there.
func replaceSymlink(link, target string) error {
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		return fsError(err)
	}
	if err := os.Remove(link); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fsError(fmt.Errorf("cannot replace %s: %w", link, err))
	}
	if err := os.Symlink(target, link); err != nil {
		return fsError(err)
	}
	return nil
}
