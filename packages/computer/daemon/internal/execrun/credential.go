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
// From e2b-dev/infra@ff3922213f02 packages/envd/internal/services/process/handler/handler.go (New: the credential,
// supplementary groups and environment), internal/permissions/user.go (GetUserIdUints) and internal/permissions/path.go
// (expand, ExpandAndResolve). Changed for the open platform: the user may be a uid[:gid] that /etc/passwd lacks, no
// credential is set when the user is the daemon's own, a switch the daemon has no capability for is refused in words,
// no default workdir, and no oom/nice shell wrapper (argv runs as given, never through a shell).

package execrun

import (
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

const defaultPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// account is who a program runs as.
type account struct {
	uid, gid uint32
	groups   []uint32
	name     string
	home     string
}

// resolveUser reads a user name, or uid[:gid]. An empty spec is the daemon's own user.
func resolveUser(spec string) (account, error) {
	if spec == "" {
		return selfAccount(), nil
	}
	idPart, gidPart, hasGid := strings.Cut(spec, ":")
	var u *user.User
	var err error
	if _, notNumber := strconv.ParseUint(idPart, 10, 32); notNumber == nil {
		u, err = user.LookupId(idPart)
		if err != nil {
			u = &user.User{Uid: idPart, Gid: idPart, Username: idPart, HomeDir: "/"}
		}
	} else if u, err = user.Lookup(idPart); err != nil {
		return account{}, rpc.Errorf(rpc.KindNotFound, "no user %q in this computer", idPart)
	}
	if hasGid {
		if _, err := strconv.ParseUint(gidPart, 10, 32); err != nil {
			return account{}, rpc.Errorf(rpc.KindInvalid, "user %q: the group must be a number", spec)
		}
		u.Gid = gidPart
	}
	uid, gid, err := getUserIdUints(u)
	if err != nil {
		return account{}, rpc.Errorf(rpc.KindInvalid, "user %q: %v", spec, err)
	}
	acct := account{uid: uid, gid: gid, groups: []uint32{gid}, name: u.Username, home: u.HomeDir}
	if gids, err := u.GroupIds(); err == nil {
		for _, g := range gids {
			if parsed, err := strconv.ParseUint(g, 10, 32); err == nil && uint32(parsed) != gid {
				acct.groups = append(acct.groups, uint32(parsed))
			}
		}
	}
	return acct, nil
}

// selfAccount is the daemon's own user. Its HOME is the one the computer was given (a provider sets it); the image's
// passwd entry only fills it when none was.
func selfAccount() account {
	acct := account{uid: uint32(os.Getuid()), gid: uint32(os.Getgid()), home: os.Getenv("HOME")}
	if u, err := user.LookupId(strconv.Itoa(os.Getuid())); err == nil {
		acct.name = u.Username
		if acct.home == "" {
			acct.home = u.HomeDir
		}
	}
	return acct
}

func getUserIdUints(u *user.User) (uid, gid uint32, err error) {
	newUID, err := strconv.ParseUint(u.Uid, 10, 32)
	if err != nil {
		return 0, 0, fmt.Errorf("error parsing uid '%s': %w", u.Uid, err)
	}
	newGID, err := strconv.ParseUint(u.Gid, 10, 32)
	if err != nil {
		return 0, 0, fmt.Errorf("error parsing gid '%s': %w", u.Gid, err)
	}
	return uint32(newUID), uint32(newGID), nil
}

// credential is what the child switches to, or nil when it runs as the daemon's own user. A switch needs CAP_SETUID
// and CAP_SETGID; without them the run is refused before any fork.
func credential(acct account) (*syscall.Credential, error) {
	if acct.uid == uint32(os.Getuid()) && acct.gid == uint32(os.Getgid()) {
		return nil, nil
	}
	if !hasCapability(capSetgid) || !hasCapability(capSetuid) {
		return nil, rpc.Errorf(rpc.KindDenied, "the daemon runs as uid %d without CAP_SETUID and CAP_SETGID, so it cannot run a program as uid %d gid %d; leave user unset to run as uid %d", os.Getuid(), acct.uid, acct.gid, os.Getuid())
	}
	return &syscall.Credential{Uid: acct.uid, Gid: acct.gid, Groups: acct.groups}, nil
}

const (
	capSetgid = 6
	capSetuid = 7
)

// hasCapability reads the effective capability set of this process from /proc/self/status.
func hasCapability(bit uint) bool {
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return false
	}
	for line := range strings.Lines(string(data)) {
		if hex, ok := strings.CutPrefix(line, "CapEff:"); ok {
			caps, err := strconv.ParseUint(strings.TrimSpace(hex), 16, 64)
			return err == nil && caps&(1<<bit) != 0
		}
	}
	return false
}

// environment is PATH (the daemon's, or a standard one), HOME, USER and LOGNAME for the account, then the request's
// variables over them. Nothing else of the daemon's environment is passed on.
func environment(acct account, extra map[string]string) []string {
	path := os.Getenv("PATH")
	if path == "" {
		path = defaultPath
	}
	vars := map[string]string{"PATH": path}
	if acct.home != "" {
		vars["HOME"] = acct.home
	}
	if acct.name != "" {
		vars["USER"], vars["LOGNAME"] = acct.name, acct.name
	}
	for key, value := range extra {
		vars[key] = value
	}
	env := make([]string, 0, len(vars))
	for key, value := range vars {
		env = append(env, key+"="+value)
	}
	return env
}

func expand(path, homedir string) (string, error) {
	if len(path) == 0 || path[0] != '~' {
		return path, nil
	}
	if len(path) > 1 && path[1] != '/' && path[1] != '\\' {
		return "", errors.New("cannot expand user-specific home dir")
	}
	return filepath.Join(homedir, path[1:]), nil
}

// resolveCwd expands ~ and makes a relative path relative to the account's home. Empty is the daemon's own directory.
func resolveCwd(path string, acct account) (string, error) {
	if path == "" {
		return "", nil
	}
	path, err := expand(path, acct.home)
	if err != nil {
		return "", rpc.Errorf(rpc.KindInvalid, "cwd %q: %v", path, err)
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(acct.home, path)
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", rpc.Errorf(rpc.KindNotFound, "cwd %q does not exist in this computer", path)
	}
	if !info.IsDir() {
		return "", rpc.Errorf(rpc.KindInvalid, "cwd %q is not a directory", path)
	}
	return path, nil
}

// lookPath finds argv[0] on the PATH the program gets, not the daemon's. A relative name with a slash, and a relative
// PATH entry (an empty one is "."), are relative to dir, where the program runs; an empty dir is the daemon's own.
func lookPath(name string, env []string, dir string) (string, error) {
	if dir == "" {
		wd, err := os.Getwd()
		if err != nil {
			return "", fmt.Errorf("cannot read the daemon's directory: %w", err)
		}
		dir = wd
	}
	inDir := func(path string) string {
		if filepath.IsAbs(path) {
			return path
		}
		return filepath.Join(dir, path)
	}
	if strings.Contains(name, "/") {
		if path := inDir(name); isExecutable(path) {
			return path, nil
		}
		return "", rpc.Errorf(rpc.KindNotFound, "%s is not an executable file in %s in this computer", name, dir)
	}
	path := defaultPath
	for _, kv := range env {
		if value, ok := strings.CutPrefix(kv, "PATH="); ok {
			path = value
		}
	}
	for _, entry := range filepath.SplitList(path) {
		if entry == "" {
			entry = "."
		}
		if candidate := inDir(filepath.Join(entry, name)); isExecutable(candidate) {
			return candidate, nil
		}
	}
	return "", rpc.Errorf(rpc.KindNotFound, "%s is not on PATH (%s) in this computer", name, path)
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}
