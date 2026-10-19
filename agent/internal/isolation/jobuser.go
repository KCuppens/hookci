package isolation

import (
	"fmt"
	"os/user"
	"strconv"
	"syscall"
)

// JobCredential returns the uid and gid the jobs of iso run as: DefaultUser's
// under systemd, and nil under none, whose jobs run as the agent's own user.
func JobCredential(iso Isolation) (*syscall.Credential, error) {
	if iso.Name() != "systemd" {
		return nil, nil
	}
	return LookupCredential(DefaultUser)
}

// LookupCredential returns the uid and primary gid of the named account.
func LookupCredential(name string) (*syscall.Credential, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return nil, fmt.Errorf("isolation: job user: %w", err)
	}
	uid, err := strconv.ParseUint(u.Uid, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("isolation: job user %s: uid %q: %w", name, u.Uid, err)
	}
	gid, err := strconv.ParseUint(u.Gid, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("isolation: job user %s: gid %q: %w", name, u.Gid, err)
	}
	return &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)}, nil
}
