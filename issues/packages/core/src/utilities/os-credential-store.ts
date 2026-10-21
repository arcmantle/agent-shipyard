import { execFile, type ChildProcess } from "node:child_process";

/** Not-found exit code convention per platform's own credential tool (macOS `security`; PowerShell script mirrors it for consistency). Linux `secret-tool lookup` prints nothing and exits 1 on a miss, which is indistinguishable from other failures, so it is treated as "not found" only for `getCredential`/`deleteCredential`, never for `setCredential`. */
const NOT_FOUND_EXIT_CODE: Partial<Record<NodeJS.Platform, number>> = {
	darwin: 44,
	win32: 44
};

export type CredentialCommand = { file: string; args: string[]; input?: string; windowsHide?: boolean };
export type CredentialCommandResult = { stdout: string; exitCode: number; stderr?: string };
export type RunCredentialCommand = (command: CredentialCommand) => Promise<CredentialCommandResult>;

export type OsCredentialStoreOptions = {
	/** Overrides platform dispatch; defaults to `process.platform`. Only meant for tests - there is exactly one real platform per machine. */
	platform?: NodeJS.Platform;
	/** Overrides how a dispatched command is actually executed; defaults to a real child_process invocation. Tests inject a fake to assert dispatch/parsing without touching a real OS credential store. */
	runCommand?: RunCredentialCommand;
	/**
	 * macOS only: scopes `security` calls to a specific keychain file instead
	 * of the user's real login keychain. Used by the real-keychain
	 * integration test so it never touches persistent user credentials.
	 */
	darwinKeychainPath?: string;
};

function runRealCommand(command: CredentialCommand): Promise<CredentialCommandResult> {
	return new Promise((resolve, reject) => {
		const child: ChildProcess = execFile(command.file, command.args, { encoding: "utf8", windowsHide: command.windowsHide }, (error, stdout, stderr) => {
			if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
				reject(error);
				return;
			}

			const exitCode = error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
				? ((error as unknown as { code: number }).code)
				: error
					? 1
					: 0;
			resolve({ stdout, exitCode, stderr });
		});

		if (command.input !== undefined) {
			child.stdin?.end(command.input);
		}
	});
}

function toolNameFor(platform: NodeJS.Platform): string {
	switch (platform) {
		case "darwin":
			return "security";
		case "linux":
			return "secret-tool";
		case "win32":
			return "powershell";
		default:
			throw new Error(`No native OS credential tool support for platform "${platform}".`);
	}
}

function buildWindowsScript(action: "set" | "get" | "delete", target: string, secret?: string): string {
	const preamble = `
$ErrorActionPreference = "Stop"
Add-Type -Namespace AgentIssues -Name Cred -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL {
	public int Flags;
	public int Type;
	public string TargetName;
	public string Comment;
	public long LastWritten;
	public int CredentialBlobSize;
	public IntPtr CredentialBlob;
	public int Persist;
	public int AttributeCount;
	public IntPtr Attributes;
	public string TargetAlias;
	public string UserName;
}
[DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool CredWrite(ref CREDENTIAL credential, int flags);
[DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);
[DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool CredDelete(string target, int type, int flags);
[DllImport("advapi32.dll")]
public static extern void CredFree(IntPtr cred);
'@
$target = '${target.replace(/'/g, "''")}'
`;

	if (action === "set") {
		return `${preamble}
$bytes = [System.Text.Encoding]::Unicode.GetBytes('${(secret ?? "").replace(/'/g, "''")}')
$blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
$cred = New-Object AgentIssues.Cred+CREDENTIAL
$cred.Type = 1
$cred.TargetName = $target
$cred.CredentialBlobSize = $bytes.Length
$cred.CredentialBlob = $blob
$cred.Persist = 2
$ok = [AgentIssues.Cred]::CredWrite([ref]$cred, 0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
if (-not $ok) { exit 1 }
`;
	}

	if (action === "get") {
		return `${preamble}
$ptr = [IntPtr]::Zero
$ok = [AgentIssues.Cred]::CredRead($target, 1, 0, [ref]$ptr)
if (-not $ok) { exit 44 }
$cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][AgentIssues.Cred+CREDENTIAL])
$bytes = New-Object byte[] $cred.CredentialBlobSize
[Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
[AgentIssues.Cred]::CredFree($ptr)
[Console]::Out.Write([System.Text.Encoding]::Unicode.GetString($bytes))
`;
	}

	return `${preamble}
$ok = [AgentIssues.Cred]::CredDelete($target, 1, 0)
if (-not $ok) { exit 44 }
`;
}

function buildWindowsCommand(action: "set" | "get" | "delete", service: string, account: string, secret?: string): CredentialCommand {
	const target = `${service}:${account}`;
	const script = buildWindowsScript(action, target, secret);
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	return {
		file: "powershell.exe",
		args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
		windowsHide: true
	};
}

function buildCommand(
	action: "set" | "get" | "delete",
	platform: NodeJS.Platform,
	service: string,
	account: string,
	secret: string | undefined,
	darwinKeychainPath: string | undefined
): CredentialCommand {
	if (platform === "darwin") {
		const keychainArg = darwinKeychainPath ? [darwinKeychainPath] : [];
		if (action === "set") {
			return { file: "security", args: ["add-generic-password", "-a", account, "-s", service, "-w", secret ?? "", "-U", ...keychainArg] };
		}
		if (action === "get") {
			return { file: "security", args: ["find-generic-password", "-a", account, "-s", service, "-w", ...keychainArg] };
		}
		return { file: "security", args: ["delete-generic-password", "-a", account, "-s", service, ...keychainArg] };
	}

	if (platform === "linux") {
		if (action === "set") {
			return {
				file: "secret-tool",
				args: ["store", "--label", `${service} (${account})`, "service", service, "account", account],
				input: secret
			};
		}
		if (action === "get") {
			return { file: "secret-tool", args: ["lookup", "service", service, "account", account] };
		}
		return { file: "secret-tool", args: ["clear", "service", service, "account", account] };
	}

	if (platform === "win32") {
		return buildWindowsCommand(action, service, account, secret);
	}

	throw new Error(`No native OS credential tool support for platform "${platform}".`);
}

async function execute(
	action: "set" | "get" | "delete",
	service: string,
	account: string,
	secret: string | undefined,
	options?: OsCredentialStoreOptions
): Promise<CredentialCommandResult> {
	const platform = options?.platform ?? process.platform;
	const runCommand = options?.runCommand ?? runRealCommand;
	const command = buildCommand(action, platform, service, account, secret, options?.darwinKeychainPath);

	try {
		return await runCommand(command);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			throw new Error(
				`Cannot ${action === "delete" ? "remove" : action === "get" ? "read" : "store"} a credential: the "${toolNameFor(platform)}" native OS credential tool is not available on this machine. Install it, then try again.`
			);
		}
		throw error;
	}
}

function isNotFound(platform: NodeJS.Platform, result: CredentialCommandResult): boolean {
	if (result.exitCode === 0) return false;
	const notFoundCode = NOT_FOUND_EXIT_CODE[platform];
	if (notFoundCode !== undefined) return result.exitCode === notFoundCode;
	// Linux `secret-tool` has no distinct not-found exit code - any non-zero exit from a
	// lookup/clear is treated as "not found" so callers get the same absent-is-fine behavior.
	return true;
}

/** Persists `secret` under `service`/`account` via the current platform's native OS credential tool (ADR46). Overwrites any existing value for the same `service`/`account`. */
export async function setCredential(service: string, account: string, secret: string, options?: OsCredentialStoreOptions): Promise<void> {
	const result = await execute("set", service, account, secret, options);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to store credential "${service}"/"${account}": ${result.stderr ?? `exit code ${result.exitCode}`}`);
	}
}

/** Reads back a previously-stored credential, or `undefined` if none exists for this `service`/`account`. */
export async function getCredential(service: string, account: string, options?: OsCredentialStoreOptions): Promise<string | undefined> {
	const platform = options?.platform ?? process.platform;
	const result = await execute("get", service, account, undefined, options);
	if (isNotFound(platform, result)) return undefined;
	if (result.exitCode !== 0) {
		throw new Error(`Failed to read credential "${service}"/"${account}": ${result.stderr ?? `exit code ${result.exitCode}`}`);
	}
	return result.stdout.replace(/\r?\n$/, "");
}

/** Removes a stored credential. Safe to call even if no credential exists for this `service`/`account`. */
export async function deleteCredential(service: string, account: string, options?: OsCredentialStoreOptions): Promise<void> {
	const platform = options?.platform ?? process.platform;
	const result = await execute("delete", service, account, undefined, options);
	if (isNotFound(platform, result)) return;
	if (result.exitCode !== 0) {
		throw new Error(`Failed to delete credential "${service}"/"${account}": ${result.stderr ?? `exit code ${result.exitCode}`}`);
	}
}
