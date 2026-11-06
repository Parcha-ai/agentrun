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
// writeViaTemp, writeExtractError). Changed for the open platform: the target directory is held open as a directory
// descriptor, and every write goes through descriptors opened from it one name at a time, never following a symlink,
// instead of a path checked (SanitizePath) and then used by name; an entry that is absolute or has a ".." part is
// refused before it is cleaned; no gzip and no entry or byte cap (the disk is the limit); no fsync per file; the count
// of entries written is returned; directory modes are applied once the archive ends; errors are the protocol's kinds,
// naming the entry.

package files

import (
	"archive/tar"
	"errors"
	"io"
	"io/fs"
	"maps"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

const (
	// tmpPrefix names the temporary entries extraction makes beside a target.
	tmpPrefix = ".computerd-tmp-"
	// oPath is O_PATH, which the syscall package lacks on amd64. A directory opened with it can be walked with search
	// permission alone.
	oPath    = 0x200000
	atFDCWD  = -100
	dirFlags = oPath | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
)

// betweenCheckAndUse is nil outside tests: it runs once a directory an entry needs (rel, below the target) is checked,
// before it is used, so a test can swap it.
var betweenCheckAndUse func(rel string)

// extractTar writes the entries of the tar stream src below dir, which is absolute and resolved, and returns how many
// it wrote. It is not atomic: on an error, the entries written so far stay. Directories keep owner access until the
// end, then get their archived modes, deepest first, so a read-only directory never blocks what goes in it.
func extractTar(src io.Reader, dir string) (entries int, err error) {
	root, err := openDir(atFDCWD, dir)
	if err != nil {
		return 0, fsError(&fs.PathError{Op: "open", Path: dir, Err: err})
	}
	defer syscall.Close(root)
	dirs := map[string]os.FileMode{}
	defer func() {
		if modeErr := applyDirModes(root, dirs); err == nil {
			err = modeErr
		}
	}()
	tr := tar.NewReader(src)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return entries, nil
		}
		if err != nil {
			return entries, rpc.Errorf(rpc.KindInvalid, "the archive cannot be read after %d entries: %v", entries, err)
		}
		wrote, err := extractEntry(tr, hdr, root, dirs)
		if err != nil {
			return entries, err
		}
		if wrote {
			entries++
		}
	}
}

func applyDirModes(root int, dirs map[string]os.FileMode) error {
	names := slices.Collect(maps.Keys(dirs))
	slices.SortFunc(names, func(a, b string) int { return strings.Count(b, "/") - strings.Count(a, "/") })
	for _, name := range names {
		parts := strings.Split(name, "/")
		parent, err := walk(root, parts[:len(parts)-1], false)
		if err == nil {
			err = chmodDir(parent, parts[len(parts)-1], dirs[name])
			_ = syscall.Close(parent)
		}
		if err != nil {
			return entryError(name+"/", err)
		}
	}
	return nil
}

// extractEntry writes one entry below root: a regular file, a directory or a symlink. Hard links, which could alias a
// file outside root, and devices and pipes are refused. A directory is left with owner access, its mode put in dirs.
func extractEntry(body io.Reader, hdr *tar.Header, root int, dirs map[string]os.FileMode) (bool, error) {
	if hdr.Typeflag == tar.TypeXGlobalHeader {
		return false, nil // git archive writes one that carries the commit id.
	}
	switch hdr.Typeflag {
	case tar.TypeDir, tar.TypeReg, tar.TypeSymlink:
	default:
		return false, rpc.Errorf(rpc.KindInvalid, "entry %q has type %q: a push makes only files, directories and symlinks", hdr.Name, hdr.Typeflag)
	}
	if filepath.IsAbs(hdr.Name) || slices.Contains(strings.Split(filepath.ToSlash(hdr.Name), "/"), "..") {
		return false, rpc.Errorf(rpc.KindDenied, "entry %q is outside the target directory", hdr.Name)
	}
	name := filepath.ToSlash(filepath.Clean(hdr.Name))
	if name == "." {
		return false, nil
	}
	parts := strings.Split(name, "/")
	parent, err := walk(root, parts[:len(parts)-1], true)
	if err != nil {
		return false, entryError(hdr.Name, err)
	}
	defer syscall.Close(parent)
	leaf := parts[len(parts)-1]
	isDir := hdr.Typeflag == tar.TypeDir
	if there, err := lstatAt(parent, leaf); err == nil && there.IsDir() != isDir {
		return false, rpc.Errorf(rpc.KindExists, "entry %q meets a %s already there", hdr.Name, typeOf(there))
	}
	perm := hdr.FileInfo().Mode().Perm()
	switch hdr.Typeflag {
	case tar.TypeDir:
		err = syscall.Mkdirat(parent, leaf, 0o700)
		if err == nil || errors.Is(err, syscall.EEXIST) {
			err = chmodDir(parent, leaf, perm|0o700)
		}
		if err == nil {
			dirs[name] = perm
		}
	case tar.TypeReg:
		err = writeFileAt(parent, leaf, body, perm)
	default:
		err = symlinkAt(parent, leaf, hdr.Linkname)
	}
	if err != nil {
		return false, entryError(hdr.Name, err)
	}
	return true, nil
}

// entryError names the entry an error is for. A symlink or a file where a directory is needed is denied: a push
// writes only through directories.
func entryError(name string, err error) error {
	if errors.Is(err, syscall.ENOTDIR) || errors.Is(err, syscall.ELOOP) {
		return rpc.Errorf(rpc.KindDenied, "entry %q is outside the target directory: a symlink or a file is on its way", name)
	}
	var e *rpc.Error
	if errors.As(err, &e) {
		return e
	}
	return fsError(&fs.PathError{Op: "extract", Path: name, Err: err})
}

// walk opens the directory that parts name below root, one name at a time from root's descriptor, never following a
// symlink; with create, a missing directory is made (0755 less the umask). The caller closes what it returns.
func walk(root int, parts []string, create bool) (int, error) {
	dir, err := openDir(root, ".")
	if err != nil {
		return -1, err
	}
	for i, part := range parts {
		next, err := openDir(dir, part)
		if create && errors.Is(err, syscall.ENOENT) {
			if err = syscall.Mkdirat(dir, part, 0o755); err == nil || errors.Is(err, syscall.EEXIST) {
				if betweenCheckAndUse != nil {
					betweenCheckAndUse(strings.Join(parts[:i+1], "/"))
				}
				next, err = openDir(dir, part)
			}
		}
		_ = syscall.Close(dir)
		if err != nil {
			return -1, err
		}
		dir = next
	}
	return dir, nil
}

// openDir opens name in the directory dirfd as a directory, never following a symlink: a symlink or anything else
// that is not a directory is ENOTDIR or ELOOP.
func openDir(dirfd int, name string) (int, error) {
	fd, err := openat(dirfd, name, dirFlags, 0)
	if err != nil {
		return -1, err
	}
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		_ = syscall.Close(fd)
		if err == nil {
			err = syscall.ENOTDIR
		}
		return -1, err
	}
	return fd, nil
}

// chmodDir sets the mode of the directory name in dirfd, through a descriptor opened without following a symlink.
func chmodDir(dirfd int, name string, mode os.FileMode) error {
	fd, err := openat(dirfd, name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	return syscall.Fchmod(fd, uint32(mode.Perm()))
}

// lstatAt is the type of name in dirfd, a symlink as itself.
func lstatAt(dirfd int, name string) (fs.FileMode, error) {
	fd, err := openat(dirfd, name, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return 0, err
	}
	defer syscall.Close(fd)
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return 0, err
	}
	switch st.Mode & syscall.S_IFMT {
	case syscall.S_IFREG:
		return 0, nil
	case syscall.S_IFDIR:
		return fs.ModeDir, nil
	case syscall.S_IFLNK:
		return fs.ModeSymlink, nil
	}
	return fs.ModeIrregular, nil
}

func openat(dirfd int, name string, flags int, mode uint32) (int, error) {
	for {
		fd, err := syscall.Openat(dirfd, name, flags, mode)
		if !errors.Is(err, syscall.EINTR) {
			return fd, err
		}
	}
}

func tempName() string { return tmpPrefix + strconv.FormatUint(rand.Uint64(), 36) }

// writeFileAt writes src to a new temporary file in dirfd, then renames it over name, which replaces a file or a
// symlink there (the link itself, never what it points to). On any failure, the connection's end included, the
// temporary file is removed.
func writeFileAt(dirfd int, name string, src io.Reader, perm os.FileMode) (err error) {
	tmp := tempName()
	fd, err := openat(dirfd, tmp, syscall.O_CREAT|syscall.O_EXCL|syscall.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), name)
	defer func() {
		if err != nil {
			_ = f.Close()
			_ = syscall.Unlinkat(dirfd, tmp)
		}
	}()
	if err = f.Chmod(perm); err != nil {
		return err
	}
	if _, err = io.Copy(f, src); err != nil {
		var written *fs.PathError
		if errors.As(err, &written) {
			return err
		}
		return rpc.Errorf(rpc.KindInvalid, "the archive cannot be read in %s: %v", name, err)
	}
	if err = f.Close(); err != nil {
		return err
	}
	return syscall.Renameat(dirfd, tmp, dirfd, name)
}

// symlinkAt makes name in dirfd a symlink to target: a temporary link, renamed over what is there.
func symlinkAt(dirfd int, name, target string) error {
	tmp := tempName()
	if err := symlinkat(target, dirfd, tmp); err != nil {
		return err
	}
	if err := syscall.Renameat(dirfd, tmp, dirfd, name); err != nil {
		_ = syscall.Unlinkat(dirfd, tmp)
		return err
	}
	return nil
}

// symlinkat is symlinkat(2), which the syscall package does not export.
func symlinkat(target string, dirfd int, name string) error {
	targetPtr, err := syscall.BytePtrFromString(target)
	if err != nil {
		return err
	}
	namePtr, err := syscall.BytePtrFromString(name)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall(syscall.SYS_SYMLINKAT, uintptr(unsafe.Pointer(targetPtr)), uintptr(dirfd), uintptr(unsafe.Pointer(namePtr)))
	if errno != 0 {
		return errno
	}
	return nil
}
