# hookci-node-app

Zero-dependency Node fixture without a `.hookci.yml`: `hookci run` detects its `lint`, `typecheck` and `test` scripts, each of which sleeps about 300ms and prints `HOOKCI_E2E <job> start|end <unix ms>`.
`agent/internal/e2e` runs it end to end and reads those lines from the job logs to prove the jobs run in parallel within the slot cap; `.npmrc` keeps npm offline so the test needs no network.
