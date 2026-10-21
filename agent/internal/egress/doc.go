// Package egress implements the per-run HTTP CONNECT proxy that is the only
// way traffic leaves a run's network namespace.
//
// Threat model: jobs run untrusted PR code. That code must not reach the
// cloud metadata endpoint (169.254.169.254), services listening on the host's
// loopback (the Caddy admin API, production ports, the agent itself) or
// anything else on private networks. It may only fetch dependencies from
// package registries.
//
// One Proxy runs per run on 127.0.0.1:<random port> on the host. It accepts
// only "CONNECT <host>:443" for exact host names on the run's AllowList. It
// resolves the host itself, refuses the request when any returned address is
// not public unicast (IsForbiddenIP), and dials the vetted IP, never the host
// name again, so DNS rebinding cannot swap in a private address after the
// check. Plain HTTP proxying and IP-literal targets are refused. The proxy
// never logs request bodies or tunnel payloads; every connection produces one
// Decision for the run log.
package egress
