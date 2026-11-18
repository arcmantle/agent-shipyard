#!/usr/bin/env bash
# Packs Arcmantle.AgentLogbook, installs it into an isolated tool directory,
# runs agent-logbook --version, checks the installed commands, and uninstalls it.
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

dotnet tool uninstall Arcmantle.AgentLogbook --tool-path "$tool_path" >/dev/null
[ ! -e "$tool_path/agent-logbook" ] || { echo "FAIL: uninstall left the command" >&2; exit 1; }

echo "OK: Arcmantle.AgentLogbook $version installed, ran, and uninstalled"
