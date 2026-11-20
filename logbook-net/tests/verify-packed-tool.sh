#!/usr/bin/env bash
# Packs Arcmantle.AgentLogbook, installs it into an isolated tool directory,
# runs agent-logbook --version and project-identity, checks the installed commands, and uninstalls it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

feed="$work/feed"
tool_path="$work/tools"
mkdir -p "$feed"

dotnet pack "$root/src/AgentLogbook.Cli/AgentLogbook.Cli.csproj" -c Release -o "$feed" --nologo -v quiet

package="$(ls "$feed"/Arcmantle.AgentLogbook.*.nupkg)"
version="$(basename "$package" .nupkg)"
version="${version#Arcmantle.AgentLogbook.}"

# The package must be one framework-dependent "any" tool package: no RID-specific layout.
listing="$(unzip -l "$package")"
settings="$(unzip -p "$package" tools/net11.0/any/DotnetToolSettings.xml)" \
	|| { echo "FAIL: package is not an 'any' tool package" >&2; exit 1; }
if grep -qE '/(osx|linux|win)-' <<<"$listing"; then
	echo "FAIL: package contains a RID-specific layout" >&2; exit 1
fi
grep -q 'Name="agent-logbook"' <<<"$settings" \
	|| { echo "FAIL: tool command is not agent-logbook" >&2; exit 1; }

dotnet tool install Arcmantle.AgentLogbook --tool-path "$tool_path" \
	--add-source "$feed" --version "$version" --ignore-failed-sources >/dev/null

commands="$(ls "$tool_path" | grep -v '^\.store$')"
[ "$commands" = "agent-logbook" ] || { echo "FAIL: unexpected commands: $commands" >&2; exit 1; }

output="$("$tool_path/agent-logbook" --version)"
[ "$output" = "$version" ] || { echo "FAIL: --version printed '$output', expected '$version'" >&2; exit 1; }

if "$tool_path/agent-logbook" --bogus >/dev/null 2>&1; then
	echo "FAIL: unknown argument exited 0" >&2; exit 1
fi

# The metadata commands run from the packed tool: help, schema, and capabilities need no workspace, database, or API host.
tool="$tool_path/agent-logbook"
help_output="$("$tool" help project-identity)"
[ "$(head -n 1 <<<"$help_output")" = "project-identity" ] \
	|| { echo "FAIL: help project-identity did not print the command help" >&2; exit 1; }
[ "$help_output" = "$("$tool" project-identity --help)" ] \
	|| { echo "FAIL: help <command> differs from <command> --help" >&2; exit 1; }
"$tool" schema --json | grep -q '"entityKinds"' || { echo "FAIL: schema --json has no entityKinds" >&2; exit 1; }
capabilities="$("$tool" capabilities --json)"
grep -q '"help":' <<<"$capabilities" && grep -q '"schema":' <<<"$capabilities" \
	|| { echo "FAIL: capabilities --json lacks help or schema" >&2; exit 1; }
for command in schema capabilities help; do
	if stdout="$("$tool" "$command" --bogus 2>/dev/null)"; then
		echo "FAIL: $command --bogus exited 0" >&2; exit 1
	fi
	[ -z "$stdout" ] || { echo "FAIL: $command --bogus printed to stdout" >&2; exit 1; }
done
if "$tool" help nosuch >/dev/null 2>&1; then
	echo "FAIL: help for an unknown command exited 0" >&2; exit 1
fi

# project-identity reads the workspace only: no PostgreSQL and no Local API host run here.
workspace="$work/workspace/My Project"
mkdir -p "$workspace"
touch "$workspace/pnpm-workspace.yaml"
identity() { (cd "$workspace" && env -u AGENT_SHIPYARD_PROJECT_IDENTITY -u AGENT_ISSUES_PROJECT_IDENTITY "$tool_path/agent-logbook" project-identity --json); }
expect_identity() {
	local actual
	actual="$(identity)"
	[ "$actual" = "{\"command\":\"project-identity\",\"identity\":\"$1\",\"source\":\"$2\"}" ] \
		|| { echo "FAIL: project-identity printed '$actual', expected $1 from $2" >&2; exit 1; }
}
expect_identity my-project folder-name
echo '{"projectIdentity":"Old File"}' > "$workspace/.agent-issues.json"
expect_identity old-file project-file
echo '{"projectIdentity":"New File"}' > "$workspace/.agent-shipyard.json"
expect_identity new-file project-file
[ "$(cd "$workspace" && AGENT_ISSUES_PROJECT_IDENTITY="Old Env" "$tool_path/agent-logbook" project-identity --json)" \
	= '{"command":"project-identity","identity":"old-env","source":"environment"}' ] \
	|| { echo "FAIL: old environment variable not applied" >&2; exit 1; }
[ "$(cd "$workspace" && AGENT_SHIPYARD_PROJECT_IDENTITY="New Env" AGENT_ISSUES_PROJECT_IDENTITY="Old Env" "$tool_path/agent-logbook" project-identity --json)" \
	= '{"command":"project-identity","identity":"new-env","source":"environment"}' ] \
	|| { echo "FAIL: new environment variable does not win" >&2; exit 1; }

# The installed command serves MCP over standard input and output. Standard output holds protocol messages only; no API host runs here.
mcp_output="$(cd "$workspace" && {
	printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"1"}}}' \
		'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
		'{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
		'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"project_identity","arguments":{}}}'
	# A host keeps the input open while it waits for answers. Closing it at once ends the session before the replies.
	sleep 5
} | "$tool_path/agent-logbook" --mcp)"
[ "$(wc -l <<<"$mcp_output" | tr -d ' ')" = "3" ] || { echo "FAIL: --mcp printed an unexpected number of lines: $mcp_output" >&2; exit 1; }
grep -q "\"name\":\"agent-logbook\",\"version\":\"$version\"" <<<"$mcp_output" || { echo "FAIL: --mcp server info lacks the tool name and version" >&2; exit 1; }
grep -q '"name":"project_identity"' <<<"$mcp_output" && grep -q '"name":"resource_show"' <<<"$mcp_output" \
	|| { echo "FAIL: --mcp did not list its tools" >&2; exit 1; }
grep -q '"projectIdentity":"new-file"' <<<"$mcp_output" || { echo "FAIL: --mcp project_identity did not resolve the workspace identity" >&2; exit 1; }
if "$tool_path/agent-logbook" --mcp --bogus </dev/null >/dev/null 2>&1; then
	echo "FAIL: --mcp with an unknown argument exited 0" >&2; exit 1
fi

# The documented update flow: a newer local build replaces the installed tool. No public feed is used.
IFS=. read -r major minor patch <<<"${version%%-*}"
update_version="$major.$minor.$((patch + 1))"
update_feed="$work/update-feed"
mkdir -p "$update_feed"
dotnet pack "$root/src/AgentLogbook.Cli/AgentLogbook.Cli.csproj" -c Release -o "$update_feed" --nologo -v quiet \
	-p:Version="$update_version" -p:InformationalVersion="$update_version"
dotnet tool update Arcmantle.AgentLogbook --tool-path "$tool_path" \
	--add-source "$update_feed" --version "$update_version" --ignore-failed-sources >/dev/null
output="$("$tool_path/agent-logbook" --version)"
[ "$output" = "$update_version" ] || { echo "FAIL: after update --version printed '$output', expected '$update_version'" >&2; exit 1; }

bash "$root/tests/verify-install-guide.sh"

dotnet tool uninstall Arcmantle.AgentLogbook --tool-path "$tool_path" >/dev/null
[ ! -e "$tool_path/agent-logbook" ] || { echo "FAIL: uninstall left the command" >&2; exit 1; }

echo "OK: Arcmantle.AgentLogbook $version installed, ran, and uninstalled"
