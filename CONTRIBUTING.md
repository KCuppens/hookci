# Contributing to ZeroCIDeploy

ZeroCIDeploy runs PR checks and zero-downtime deploys on your own servers. This document describes the monorepo structure, local verification requirements, coding standards, and submission workflow.

---

## Monorepo Layout

```
.
├── agent/       # Go agent daemon and CLI (`zeroci`)
├── hub/         # Cloudflare Worker coordination hub (`zeroci-hub`)
├── schema/      # Canonical JSON Schema (`zeroci.schema.json`)
├── examples/    # Example target repositories and fixture apps
├── scripts/     # Verification and codegen automation
└── Makefile     # Unified build and test targets
```

---

## Prerequisites

- **Go**: 1.24 or newer (`CGO_ENABLED=0`)
- **Node.js**: 20+ with `npm`
- **Make**: Standard POSIX `make`

---

## Local Verification (No CI)

ZeroCIDeploy does not use GitHub Actions. All pull requests are verified locally by contributors and maintainers prior to merge.

Run the full verification suite before committing:

```bash
make check
```

`make check` executes `scripts/check.sh`, which performs:
1. `agent`: Code formatting verification (`gofmt -l .`).
2. `agent`: Static analysis (`go vet ./...`).
3. `agent`: Unit tests (`go test ./...`).
4. `hub`: Clean dependency install (`npm ci`).
5. `hub`: Test suite execution (`npm test`).
6. `hub`: Cloudflare Worker dry-run deployment (`npx wrangler deploy --dry-run --outdir dist`).

### Integration Tests

Tests that require elevated Linux permissions (systemd transient units, network namespaces via `pasta`, Docker containers) are tagged with `//go:build integration` and guarded by `testutil.RequireIntegration(t)`.

Unit tests must never require root. Integration tests are executed on dedicated throwaway VMs via:

```bash
make test-integration
```

---

## Coding Standards

### Go (`agent/`)

- **Dependencies**: Default to the Go standard library. Only approved external dependencies may be introduced (`modernc.org/sqlite`, `gopkg.in/yaml.v3`, `github.com/santhosh-tekuri/jsonschema/v6`, `golang.org/x/sys`). Any other dependency requires justification in the pull request.
- **Commands & System Calls**: All external commands (`systemd-run`, `git`, `docker`, `pasta`, `ip`) must go through `execx.Runner`. Unit tests use `execx.Fake` rather than executing commands on the host.
- **Context & Errors**: Pass `context.Context` as the first argument to functions performing I/O or process control. Wrap errors with `fmt.Errorf("operation: %w", err)`. Define sentinel errors (`var Err... = errors.New(...)`) for identifiable failure conditions. Never panic in non-CLI library code.
- **Logging**: Use `log/slog` directed to `os.Stderr`.
- **Testing**: Table-driven tests with standard `testing` package. Use `t.TempDir()` for temporary directories. Golden files belong under `testdata/`.
- **Exit Codes**:
  - `0`: Success / check passed
  - `1`: Run failed (one or more checks failed)
  - `2`: CLI usage or configuration syntax error
  - `3`: No checks detected in target repository
  - `4`: Internal or unrecoverable error

### TypeScript / Cloudflare Worker (`hub/`)

- Test handlers using Vitest with `@cloudflare/vitest-pool-workers`.
- Maintain valid TypeScript configurations in `hub/tsconfig.json`.
- Do not run live wrangler deployments from local development. Only dry-run checks (`--dry-run`) are permitted.

---

## Developer Certificate of Origin (DCO)

All commits to ZeroCIDeploy must include a Developer Certificate of Origin sign-off line in the commit message:

```
Signed-off-by: Random J Developer <random@developer.example.org>
```

Use the `-s` flag with `git commit`:

```bash
git commit -s -m "component: concise summary"
```

By adding this trailer, you certify the statements in [DCO](./DCO).

---

## Submitting Pull Requests

1. **Branch**: Create a branch off `main` with a descriptive name (e.g. `feat/feature-name` or `kobe/issue-description`).
2. **Verify**: Ensure `make check` passes cleanly.
3. **Commit**: Keep commits focused and atomic, signed off with `-s`.
4. **No CI Workflows**: Do not commit files under `.github/workflows/`.
5. **Open PR**: Submit a pull request against `main` using the provided pull request template.
