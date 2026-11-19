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

dotnet tool uninstall Arcmantle.AgentLogbook --tool-path "$tool_path" >/dev/null
[ ! -e "$tool_path/agent-logbook" ] || { echo "FAIL: uninstall left the command" >&2; exit 1; }

echo "OK: Arcmantle.AgentLogbook $version installed, ran, and uninstalled"
