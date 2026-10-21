# Development

- Use `make run ARGS='...'` to run the local CLI. It reuses the local binary
	until Go source changes require a rebuild.
- Use `make build`, `make test`, and `make lint` for local validation.
- The SQLite catalog includes FTS5 and sqlite-vec by default.
- When a direct Go command is necessary, use `CGO_ENABLED=1 go build -o agent-wayfinder ./cmd/agent-wayfinder` and run `./agent-wayfinder ...`.