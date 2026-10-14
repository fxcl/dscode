//go:build windows

package filesystem

import (
	"fmt"
	"os"
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

// maxTopLevelEntries bounds the eager pass over a workspace's immediate
// children. Deeper subtrees still work: files created under them inherit the
// nearest granted ancestor's ACE.
const maxTopLevelEntries = 512

// GrantWorkspace makes the sandbox account able to work inside root.
//
// The recursive form (icacls /T) walks every descendant and is unusable on real
// repositories - a tree containing node_modules takes minutes, which overruns
// the caller's timeout and leaves the sandbox shell dead. Instead this grants
// the root non-recursively and then grants each immediate child, relying on
// Windows ACE inheritance: the (OI)(CI) flags make a directory's grant
// propagate to everything created underneath, and each granted child propagates
// in turn. Only the first level is enumerated, so cost scales with fan-out
// rather than tree size.
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
	// Root first, without /T: anything created later inherits from it.
	if err := icacls(abs, "/grant", "*"+grant.sid+":"+permission); err != nil {
		return nil, fmt.Errorf("grant workspace root: %w", err)
	}
	grant.paths = append(grant.paths, grantedPath{path: abs})

	// Then the immediate children that already exist, each granted without /T
	// so their own subtrees inherit instead of being walked. One icacls call
	// carries every path: spawning a process per directory costs ~2s each on a
	// repo with many top-level entries.
	if entries, readErr := os.ReadDir(abs); readErr == nil {
		children := make([]string, 0, len(entries))
		for index, entry := range entries {
			if index >= maxTopLevelEntries {
				break
			}
			child := filepath.Join(abs, entry.Name())
			children = append(children, child)
			grant.paths = append(grant.paths, grantedPath{path: child})
		}
		if len(children) > 0 {
			// icacls takes the target list first, then the operation:
			//   icacls <name>... /grant <sid>:<perm>
			// Best effort: paths icacls refuses are simply not granted; the root
			// grant still covers anything created later.
			_ = grantMany(children, grant.sid, permission)
		}
	}
	return grant, nil
}

// grantMany applies one non-recursive grant to many paths in a single icacls
// invocation.
func grantMany(paths []string, sid string, permission string) error {
	args := append([]string{}, paths...)
	args = append(args, "/grant", "*"+sid+":"+permission)
	_, err := icaclsOutput("", args...)
	return err
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

// icaclsOutput runs icacls with an explicit argument list (the target list may
// itself contain several paths) and returns its combined output.
func icaclsOutput(target string, args ...string) (string, error) {
	commandArgs := args
	if target != "" {
		commandArgs = append([]string{target}, args...)
	}
	output, err := exec.Command("icacls.exe", commandArgs...).CombinedOutput()
	return strings.TrimSpace(string(output)), err
}