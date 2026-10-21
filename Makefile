VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
LDFLAGS = -s -w -X github.com/KCuppens/hookci/agent/internal/version.Version=$(VERSION) -X github.com/KCuppens/hookci/agent/internal/version.Commit=$(COMMIT)

.PHONY: check schema schema-check agent test-integration hub-test

check:
	scripts/check.sh

schema:
	scripts/gen-schema.sh

schema-check:
	scripts/schema-check.sh

agent:
	mkdir -p dist
	cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../dist/hookci-linux-amd64 ./cmd/hookci
	cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../dist/hookci-linux-arm64 ./cmd/hookci
	cd agent && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../dist/hookci-darwin-arm64 ./cmd/hookci

# Runs tests tagged "integration" against real external resources. Intended
# to run on a human-operated VM, never in CI, never unattended.
test-integration:
	cd agent && HOOKCI_INTEGRATION=1 go test -tags integration -count=1 ./...

hub-test:
	cd hub && npm test
