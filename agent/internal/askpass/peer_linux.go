//go:build linux

package askpass

import (
	"fmt"
	"net"
	"os"
	"syscall"
)

// checkPeer verifies that the client connecting to the askpass socket has the
// same UID as the current process. This prevents unprivileged local users or
// processes running as different UIDs from extracting git tokens even if socket
// filesystem permissions were altered or bypassed.
func checkPeer(c net.Conn) error {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return fmt.Errorf("askpass: not a unix connection")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return fmt.Errorf("askpass: syscall conn: %w", err)
	}
	var cred *syscall.Ucred
	var sysErr error
	err = raw.Control(func(fd uintptr) {
		cred, sysErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if err != nil {
		return fmt.Errorf("askpass: control: %w", err)
	}
	if sysErr != nil {
		return fmt.Errorf("askpass: getsockopt peercred: %w", sysErr)
	}
	if int(cred.Uid) != os.Getuid() {
		return fmt.Errorf("askpass: peer uid %d != process uid %d", cred.Uid, os.Getuid())
	}
	return nil
}
