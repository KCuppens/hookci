# Examples

Sample projects and detection fixtures used to exercise the agent end to end. `node-app/` is a zero-dependency Node.js project with `lint`, `typecheck` and `test` npm scripts and no `.hookci.yml`; `hookci run` detects its checks automatically, and the end-to-end test in `agent/internal/e2e` runs it to prove the jobs run in parallel within the slot cap.

`detect/` holds one fixture per detected ecosystem (`pnpm-turbo`, `npm`, `yarn`, `bun`, `go`, `rust`, `python-uv`, `python-pip`, `compose-postgres`, and `empty`, which detects nothing). Each non-empty fixture has an `expected.hookci.yml` with the exact `hookci detect` output; `TestDetectFixtures` in `agent/internal/detect` compares against it. Regenerate the files with `cd agent && go test ./internal/detect -run TestDetectFixtures -update`.
