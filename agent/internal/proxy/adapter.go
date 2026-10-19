// Package proxy holds the compiled-in ProxyAdapter interface (plan §2).
// M0 fixes the package layout only; the Caddy adapter is implemented in M2.
package proxy

import "context"

// Adapter is the compiled-in ProxyAdapter interface (§2). Caddy implementation is M2.
type Adapter interface {
	Name() string
	Reload(ctx context.Context) error
}
