# Examples

Sample projects and detection fixtures used to exercise the agent end to end. `node-app/` is a minimal Node.js project with `lint`, `typecheck` and `test` npm scripts and no `.zeroci.yml`; `zeroci run` detects its checks automatically, and the agent end-to-end test (`agent/internal/cli/e2e_test.go`) runs against it.

`detect/` holds one fixture per detected ecosystem (`pnpm-turbo`, `npm`, `yarn`, `bun`, `go`, `rust`, `python-uv`, `python-pip`, `compose-postgres`, and `empty`, which detects nothing). Each non-empty fixture has an `expected.zeroci.yml` with the exact `zeroci detect` output; `TestDetectFixtures` in `agent/internal/detect` compares against it. Regenerate the files with `cd agent && go test ./internal/detect -run TestDetectFixtures -update`.
