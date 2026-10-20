# Contributing to zerocideploy

Thanks for helping. This document covers what you need to build, test and submit a change. By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- Go 1.26 or newer (`agent/go.mod` requires it).
- Node.js 20 or newer with `npm`.
- POSIX `make` and `sh`.

## Verify before every PR

Run this from the repository root before opening or updating a pull request:

```sh
make check
```

It runs `scripts/check.sh`, which must end with `check: ok`. The script:

1. Runs `npm ci` and `npm test` in `schema/`, which validate the fixtures in `schema/testdata/protocol` against the schema with ajv.
2. Runs `scripts/schema-check.sh` (also `make schema-check`), which regenerates the types into a temp dir and fails if any generated file in the tree differs (codegen drift).
3. Checks Go formatting with `gofmt -l`.
4. Runs `go vet ./...` and `go test ./...` in `agent/`.
5. Runs `scripts/gen-install.sh --check`, `scripts/test-install.sh` and `node scripts/gen-manifests.mjs --check`; the last fails when the dev and staging App manifests in `hub/manifests/generated/` differ from what `node scripts/gen-manifests.mjs` writes from `hub/manifests/`.
6. Runs `npm ci`, `npm test` and `npm run typecheck` in `hub/`. `npm test` also runs the `zeroci-hub` CLI tests in `hub/test/cli/` under `vitest.cli.config.ts`.
7. Runs `npx wrangler deploy --dry-run` in `hub/` for production and staging.
8. Runs `npm run prepack` in `hub/`, renders a self-hosted config with `node dist/cli/index.js render --yes` into a temp dir, and dry-runs `wrangler deploy` against it.

The project has no GitHub Actions workflows and never will. It verifies itself with `scripts/check.sh`. Do not add anything under `.github/workflows/`.

## Regenerating types

`schema/zeroci.schema.json` is the source of truth for the config format and the agent/hub protocol. The TypeScript generator is pinned in `schema/package.json`, so run `cd schema && npm ci` once. After changing the schema, run:

```sh
make schema
```

and commit the regenerated Go and TypeScript files together with the schema change. Generated files are committed and must not be edited by hand. Each new protocol message gets a `valid-*.json` and an `invalid-*.json` fixture in `schema/testdata/protocol`.

## Coding conventions

- Wrap errors with context: `fmt.Errorf("open store: %w", err)`.
- Use sentinel errors (`var ErrNotFound = errors.New(...)`) for conditions callers check with `errors.Is`.
- `ctx context.Context` is the first parameter of any function that does I/O or runs processes.
- Log with `log/slog`.
- Write table-driven tests.
- Golden files live in `testdata/` and are compared with `testutil.Golden`. Refresh them with `go test ./internal/<pkg> -update` and review the diff.
- Every external command goes through `execx.Runner`. Unit tests use `execx.Fake` and never run real commands, touch the network or need root.
- The Go agent uses the standard library first. Any new dependency needs a justification in the pull request.

## Integration tests

Tests that need root (systemd units, network namespaces, containers) start with `//go:build integration` and call `testutil.RequireIntegration(t)`, which skips unless `ZEROCI_INTEGRATION=1`, the OS is Linux and the user is root. Run them with:

```sh
make test-integration
```

Only run them on a disposable VM, never on a workstation.

## Sign-off (DCO)

Every commit must carry a `Signed-off-by:` trailer, added with `git commit -s`. The trailer certifies the [Developer Certificate of Origin](DCO.md), which also explains how to fix a missing sign-off.

## Pull requests

- One pull request per logical change. Split unrelated fixes into separate pull requests.
- Fill in the pull request template, including the linked ticket.
- Keep commits focused and signed off.
