package proxy

import "context"

// Adapter defines the interface for reverse proxy and ingress configuration (implemented in M2).
type Adapter interface {
	Configure(ctx context.Context, domain string, upstream string) error
}
