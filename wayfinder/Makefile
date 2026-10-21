.PHONY: build run test acceptance lint check benchmark-tools

AGENT_WAYFINDER_PACKAGES := $(shell go list -e ./... | grep -v '^agent-wayfinder/reference')
AGENT_WAYFINDER_BINARY := agent-wayfinder
AGENT_WAYFINDER_SOURCES := $(shell find benchmark cli cmd configuration extractor extractors graph index indexer query storage workspace -name '*.go') Makefile go.mod go.sum go.work

build: $(AGENT_WAYFINDER_BINARY)

$(AGENT_WAYFINDER_BINARY): $(AGENT_WAYFINDER_SOURCES)
	CGO_ENABLED=1 go build -o $@ ./cmd/agent-wayfinder

run: $(AGENT_WAYFINDER_BINARY)
	./$(AGENT_WAYFINDER_BINARY) $(ARGS)

test:
	CGO_ENABLED=1 go test $(AGENT_WAYFINDER_PACKAGES)

acceptance:
	CGO_ENABLED=1 go test $(AGENT_WAYFINDER_PACKAGES)

lint:
	CGO_ENABLED=1 go vet $(AGENT_WAYFINDER_PACKAGES)

check: build acceptance lint

benchmark-tools:
	node --test benchmark/runner.test.cjs