//go:build unix

package execx

import (
	"os/exec"
	"syscall"
)

// Credential is the uid/gid a command runs as.
type Credential = syscall.Credential

func setCredential(cmd *exec.Cmd, cred *Credential) {
	if cred != nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: cred}
	}
}
