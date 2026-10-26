//go:build !linux

package askpass

import "net"

// checkPeer is a no-op on non-Linux platforms where SO_PEERCRED is not available
// in the same manner.
func checkPeer(c net.Conn) error {
	return nil
}
