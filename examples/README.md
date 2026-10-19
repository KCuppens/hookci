# Examples

Sample projects and detection fixtures used to exercise the agent end to end. `node-app/` is a minimal Node.js project with `lint`, `typecheck` and `test` npm scripts and no `.zeroci.yml`; `zeroci run` detects its checks automatically, and the agent end-to-end test (`agent/internal/cli/e2e_test.go`) runs against it.
