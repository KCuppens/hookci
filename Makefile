VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
LDFLAGS = -s -w -X github.com/KCuppens/zerocideploy/agent/internal/version.Version=$(VERSION) -X github.com/KCuppens/zerocideploy/agent/internal/version.Commit=$(COMMIT)

.PHONY: check schema schema-check agent test-integration hub-test

check:
	scripts/check.sh

schema:
	scripts/gen-schema.sh

schema-check:
	scripts/schema-check.sh

agent:
	mkdir -p dist
	cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../dist/zeroci-linux-amd64 ./cmd/zeroci
	cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../dist/zeroci-linux-arm64 ./cmd/zeroci
	cd agent && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../dist/zeroci-darwin-arm64 ./cmd/zeroci

# Runs tests tagged "integration" against real external resources. Intended
# to run on a human-operated VM, never in CI, never unattended. -p 1: the
# suites share the host's systemd units and docker, so packages run one at a
# time. The M2 deploy suite alone takes about 20 minutes.
test-integration:
	cd agent && ZEROCI_INTEGRATION=1 go test -tags integration -count=1 -p 1 -timeout 90m ./...

hub-test:
	cd hub && npm test
