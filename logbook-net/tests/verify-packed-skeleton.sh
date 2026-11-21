#!/usr/bin/env bash
# Verifies the walking skeleton through the installed packed tool, in an isolated tool folder and Shipyard data folder.
#
# 1. Startup limit: `project-identity --json` must answer within STARTUP_LIMIT_MS (default 1000) as the median of
#    STARTUP_RUNS runs, and it must start no Local API host.
# 2. Skeleton paths against real PostgreSQL (AGENT_LOGBOOK_LOCAL_PG_URL, required): the automatic Local API start,
#    init, create, show, list, capabilities, `host status`, MCP stdio `resource_show`, and `host stop`.
# 3. Cleanup: no Local API host process and no discovery file remain.
#
# The script fails on the first failed check. The measured startup result is printed and, in CI, written to the job summary.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
limit_ms="${STARTUP_LIMIT_MS:-1000}"
runs="${STARTUP_RUNS:-7}"
: "${AGENT_LOGBOOK_LOCAL_PG_URL:?AGENT_LOGBOOK_LOCAL_PG_URL must name a PostgreSQL database that the skeleton run may use}"

work="$(mktemp -d)"
fail() { echo "FAIL: $1" >&2; exit 1; }

export AGENT_SHIPYARD_HOME="$work/shipyard"
unset AGENT_SHIPYARD_PROJECT_IDENTITY AGENT_ISSUES_PROJECT_IDENTITY AGENT_LOGBOOK_API_URL
discovery="$AGENT_SHIPYARD_HOME/logbook/local-api.discovery.json"

host_pid() { [ -f "$discovery" ] && sed -n 's/.*"processId": *\([0-9][0-9]*\).*/\1/p' "$discovery" | head -n 1 || true; }

cleanup() {
	local status=$?
	# Stop the host through the tool; fall back to its recorded process only for a host that this run started.
	if [ -x "${tool:-}" ] && [ -f "$discovery" ]; then
		"$tool" host stop >/dev/null 2>&1 || true
	fi
	local pid
	pid="$(host_pid)"
	if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
	rm -rf "$work"
	exit "$status"
}
trap cleanup EXIT

feed="$work/feed"
tool_path="$work/tools"
mkdir -p "$feed"
dotnet pack "$root/src/AgentLogbook.Cli/AgentLogbook.Cli.csproj" -c Release -o "$feed" --nologo -v quiet
package="$(ls "$feed"/Arcmantle.AgentLogbook.*.nupkg)"
version="$(basename "$package" .nupkg)"
version="${version#Arcmantle.AgentLogbook.}"
dotnet tool install Arcmantle.AgentLogbook --tool-path "$tool_path" --add-source "$feed" --version "$version" --ignore-failed-sources >/dev/null
tool="$tool_path/agent-logbook"

workspace="$work/workspace/Skeleton Project"
mkdir -p "$workspace"
run() { (cd "$workspace" && "$tool" "$@"); }

# ---- 1. Startup limit -------------------------------------------------------------------------------------------
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time() * 1000'; }
run project-identity --json >/dev/null # warm the disk cache; the first run is not measured
samples=()
for _ in $(seq 1 "$runs"); do
	start="$(now_ms)"
	run project-identity --json >/dev/null
	samples+=("$(( $(now_ms) - start ))")
done
median="$(printf '%s\n' "${samples[@]}" | sort -n | sed -n "$(( (runs + 1) / 2 ))p")"
summary="project-identity --json startup: median ${median} ms of ${runs} runs (${samples[*]// /, }); limit ${limit_ms} ms; package ${version}"
echo "$summary"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$summary" >> "$GITHUB_STEP_SUMMARY"; fi
[ "$median" -le "$limit_ms" ] || fail "startup limit exceeded: median ${median} ms > ${limit_ms} ms. The approved fallback is RID-specific ReadyToRun packages with an 'any' fallback."
[ ! -e "$discovery" ] || fail "project-identity started a Local API host"

# ---- 2. Skeleton paths ------------------------------------------------------------------------------------------
[ "$(run host status --json | grep -o '"state":"[a-z]*"')" = '"state":"stopped"' ] || fail "a Local API host runs before the first store request"

capabilities="$(run capabilities --json)"
grep -q '"help":' <<<"$capabilities" && grep -q '"schema":' <<<"$capabilities" || fail "capabilities --json lacks help or schema"
[ ! -e "$discovery" ] || fail "capabilities started a Local API host"

# The first store request starts the host automatically.
init="$(run init --json)"
grep -q '"command":"init"' <<<"$init" && grep -q '"status":"ok"' <<<"$init" || fail "init --json printed: $init"
[ -f "$discovery" ] || fail "init did not start the Local API host"
pid="$(host_pid)"
[ -n "$pid" ] && kill -0 "$pid" || fail "the discovery file names no live process"
[ "$(run init --json)" = "$init" ] || fail "a repeated init changed its result"

created="$(run create initiative --title "Skeleton initiative" --json)"
reference="$(sed -n 's/.*"reference":"\([^"]*\)".*/\1/p' <<<"$created")"
[ -n "$reference" ] || fail "create --json printed no reference: $created"
shown="$(run show "$reference" --json)"
grep -q "\"$reference\"" <<<"$shown" && grep -q 'Skeleton initiative' <<<"$shown" || fail "show did not return the created entity: $shown"
listed="$(run list initiative --json)"
grep -q "$reference" <<<"$listed" || fail "list did not return the created entity: $listed"

# MCP stdio uses the running host and reads the same entity.
mcp_output="$(cd "$workspace" && {
	printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"1"}}}' \
		'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
		'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"resource_show","arguments":{"request":{"resource":"entity","reference":"'"$reference"'"}}}}'
	# A host keeps the input open while it waits for answers.
	sleep 8
} | "$tool" --mcp)" || fail "--mcp or its input failed: $mcp_output"
grep -q "$reference" <<<"$mcp_output" && grep -q 'Skeleton initiative' <<<"$mcp_output" || fail "MCP resource_show did not return the created entity: $mcp_output"
[ "$(host_pid)" = "$pid" ] || fail "MCP started a second Local API host"

# A path that is not ported stays outside the skeleton claim and fails explicitly.
unported_status=0
unported_stdout="$(run context --json 2>"$work/unported.err")" || unported_status=$?
[ "$unported_status" = 1 ] && [ -z "$unported_stdout" ] && grep -q "unknown command 'context'" "$work/unported.err" \
	|| fail "an unported command was not rejected explicitly (exit $unported_status): $(cat "$work/unported.err")"

[ "$(run host status --json | grep -o '"state":"[a-z]*"')" = '"state":"running"' ] || fail "host status is not running"

# ---- 3. Cleanup -------------------------------------------------------------------------------------------------
run host stop >/dev/null
[ ! -e "$discovery" ] || fail "host stop left the discovery file"
for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$pid" 2>/dev/null; then fail "the Local API host process $pid still runs after host stop"; fi

echo "OK: walking skeleton verified through the packed Arcmantle.AgentLogbook $version"
