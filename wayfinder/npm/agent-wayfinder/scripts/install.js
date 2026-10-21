const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const zlib = require("node:zlib");

const releaseBaseURL = "https://github.com/arcmantle/agent-shipyard/releases/download";

function platformAsset(platform = process.platform, architecture = process.arch) {
  const supported = {
    darwin: new Set(["arm64"]),
    linux: new Set(["x64"]),
    win32: new Set(["x64"])
  };

  if (!supported[platform] || !supported[platform].has(architecture)) {
    throw new Error(`Unsupported platform: ${platform}-${architecture}`);
  }

  return `agent-wayfinder-${platform}-${architecture}.gz`;
}

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "user-agent": "agent-wayfinder-npm-installer" } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects === 5) {
          reject(new Error(`Too many redirects while downloading ${url}`));
          return;
        }
        resolve(download(new URL(response.headers.location, url).toString(), redirects + 1));
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }

      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

function expectedChecksum(checksums, assetName) {
  for (const line of checksums.toString("utf8").split("\n")) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match && match[2] === assetName) {
      return match[1].toLowerCase();
    }
  }
  throw new Error(`Release checksums do not contain ${assetName}`);
}

async function install() {
  const packageDirectory = path.resolve(__dirname, "..");
  const packageInfo = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
  const assetName = platformAsset();
  const releaseURL = `${releaseBaseURL}/v${packageInfo.version}`;
  const [compressedBinary, checksums] = await Promise.all([
    download(`${releaseURL}/${assetName}`),
    download(`${releaseURL}/SHA256SUMS`)
  ]);
  const expected = expectedChecksum(checksums, assetName);
  const actual = crypto.createHash("sha256").update(compressedBinary).digest("hex");
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${assetName}`);
  }

  const binaryName = process.platform === "win32" ? "agent-wayfinder.exe" : "agent-wayfinder";
  const binaryPath = path.join(packageDirectory, "bin", binaryName);
  fs.writeFileSync(binaryPath, zlib.gunzipSync(compressedBinary), { mode: 0o755 });
  fs.chmodSync(binaryPath, 0o755);
}

if (require.main === module) {
  install().catch(error => {
    console.error(`agent-wayfinder installation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { expectedChecksum, platformAsset };