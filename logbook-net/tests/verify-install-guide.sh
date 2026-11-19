#!/usr/bin/env bash
# Checks docs/installation.md against the pack metadata in the Cli project.
# It reads files only: it needs no SDK, no network, and no published package.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
guide="$root/docs/installation.md"
project="$root/src/AgentLogbook.Cli/AgentLogbook.Cli.csproj"

fail() { echo "FAIL: $1" >&2; exit 1; }

package_id="$(sed -n 's|.*<PackageId>\(.*\)</PackageId>.*|\1|p' "$project")"
command_name="$(sed -n 's|.*<ToolCommandName>\(.*\)</ToolCommandName>.*|\1|p' "$project")"
[ -n "$package_id" ] && [ -n "$command_name" ] || fail "pack metadata not found in the Cli project"

grep -qxF "dotnet tool install --global $package_id" "$guide" || fail "guide lacks the install command for $package_id"
grep -qxF "dotnet tool update --global $package_id" "$guide" || fail "guide lacks the update command for $package_id"
grep -qxF "$command_name --version" "$guide" || fail "guide lacks '$command_name --version'"
grep -qF '~/.dotnet/tools' "$guide" || fail "guide lacks the ~/.dotnet/tools PATH check"
grep -qF '.NET 11 SDK' "$guide" || fail "guide lacks the .NET 11 SDK prerequisite"
grep -qF 'includes the .NET 11 runtime' "$guide" || fail "guide does not say the SDK includes the runtime"

# The guide must not tell users to pass a source, credentials, or a local manifest.
if grep -E '^\s*dotnet tool (install|update)' "$guide" | grep -E -- '--(add-source|source|configfile|local|tool-manifest|tool-path)'; then
	fail "guide install or update command uses a source, credential, or manifest option"
fi
if grep -qiE 'dotnet new tool-manifest|dotnet tool restore|npm (i|install)|npx ' "$guide"; then
	fail "guide names a local manifest or npm distribution as an install path"
fi
echo "OK: installation guide matches $package_id / $command_name"
