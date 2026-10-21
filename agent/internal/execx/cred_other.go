//go:build !unix

package execx

import "os/exec"

// Credential is the uid/gid a command runs as. Non-unix hosts cannot switch
// users, so the stub carries no fields and is ignored.
type Credential struct{}

func setCredential(*exec.Cmd, *Credential) {}
