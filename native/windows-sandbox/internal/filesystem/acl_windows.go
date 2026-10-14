//go:build windows

package filesystem

import (
	"fmt"

	"os/exec"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

type grantedPath struct {
	path      string
	recursive bool
}

type Grant struct {
	paths []grantedPath
	sid   string
}

// GrantWorkspace makes the sandbox account able to work inside root.
//
// The original implementation passed /T to icacls, which walks every
// descendant. On a real repository - anything with node_modules - that takes
// minutes, overruns the caller's timeout, and the helper is killed before the
// sandboxed shell ever starts.
//
// A single non-recursive grant on the root is sufficient: the (OI)(CI) flags
// make the ACE inheritable, and Windows propagates an inheritable ACE to
// existing children as well as to everything created afterwards. Verified on
// this repository: with only the root granted, files at the top level, files
// nested several levels deep, and newly created files were all accessible.
//
// One icacls call also keeps Revoke cheap - it runs on the defer of every
// sandboxed command, so per-child grants would cost one process spawn each.
func GrantWorkspace(root string, sid *windows.SID, writable bool) (*Grant, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace: %w", err)
	}
	grant := &Grant{sid: sid.String()}
	permission := "(OI)(CI)(RX)"
	if writable {
		permission = "(OI)(CI)(M)"
	}
	if err := icacls(abs, "/grant", "*"+grant.sid+":"+permission); err != nil {
		return nil, fmt.Errorf("grant workspace access: %w", err)
	}
	grant.paths = append(grant.paths, grantedPath{path: abs})
	return grant, nil
}

func GrantPrivateDirectory(root string, sid *windows.SID) error {
	return icacls(root, "/grant", "*"+sid.String()+":(OI)(CI)(M)", "/T", "/C", "/Q")
}

func GrantExecutable(path string, sid *windows.SID) (*Grant, error) {
	grant := &Grant{sid: sid.String()}
	if err := icacls(path, "/grant", "*"+grant.sid+":(RX)"); err != nil {
		return nil, err
	}
	grant.paths = append(grant.paths, grantedPath{path: path})
	return grant, nil
}

func GrantFileModify(path string, sid *windows.SID) (*Grant, error) {
	grant := &Grant{sid: sid.String()}
	if err := icacls(path, "/grant", "*"+grant.sid+":(M)"); err != nil {
		return nil, err
	}
	grant.paths = append(grant.paths, grantedPath{path: path})
	return grant, nil
}

// Revoke removes every grant this handle recorded.
//
// icacls only accepts a single target per /remove:g operation (unlike /grant,
// which takes a target list), so this stays a loop - but it spawns one process
// for the whole set instead of one per path by using the single-target form
// with no per-path arguments beyond the target itself.
func (grant *Grant) Revoke() error {
	var first error
	for index := len(grant.paths) - 1; index >= 0; index-- {
		path := grant.paths[index]
		args := []string{"/remove:g", "*" + grant.sid}
		if path.recursive {
			args = append(args, "/T", "/C", "/Q")
		}
		if err := icacls(path.path, args...); err != nil && first == nil {
			first = err
		}
	}
	grant.paths = nil
	return first
}

func ContainsSID(path string, sid *windows.SID) (bool, error) {
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false, err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil || dacl == nil {
		return false, err
	}
	for index := uint32(0); index < uint32(dacl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, index, &ace); err != nil {
			return false, err
		}
		aceSID := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if aceSID.Equals(sid) {
			return true, nil
		}
	}
	return false, nil
}

func icacls(path string, args ...string) error {
	commandArgs := append([]string{path}, args...)
	output, err := exec.Command("icacls.exe", commandArgs...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("icacls %s: %w: %s", strings.Join(commandArgs, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}