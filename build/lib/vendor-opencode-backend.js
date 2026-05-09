import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

const args = process.argv.slice(2)

if (args.includes("--help")) {
  console.log("Usage: node build/lib/vendor-opencode-backend.js [--rewrite-sha256]")
  process.exit(0)
}

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const rewriteSha256 = args.includes("--rewrite-sha256")

if (rewriteSha256 && process.env.OPENCODE_BACKEND_ALLOW_REWRITE !== "1") {
  fail("Refusing to rewrite manifest sha256 without OPENCODE_BACKEND_ALLOW_REWRITE=1. This guard prevents accidental sha drift in CI.")
}

const scriptDir = path.dirname(path.resolve(process.argv[1]))
const manifestPath = path.resolve(scriptDir, "..", "opencode-backend.json")
const manifestDir = path.dirname(manifestPath)
const workspaceRoot = path.resolve(scriptDir, "..", "..", "..")
const platform = `${process.platform}-${process.arch}`

if (!fs.existsSync(manifestPath)) fail(`Manifest not found at ${manifestPath}.`)

const manifest = (() => {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  } catch (error) {
    fail(`Invalid JSON in manifest at ${manifestPath}: ${error.message}`)
  }
})()

const platformKeys = Object.keys(manifest.platforms || {})
const entry = manifest.platforms?.[platform]

if (!entry) fail(`Unsupported platform ${platform}; manifest has only [${platformKeys.join(", ")}]`)
if (entry.sha256 === null) fail(`Platform ${platform} not pinned in manifest. CI must build for this target and fill its sha256.`)

const manifestRelativeSourcePath = path.resolve(manifestDir, entry.src)
const sourcePath = fs.existsSync(manifestRelativeSourcePath) ? manifestRelativeSourcePath : path.resolve(manifestDir, "..", entry.src)

if (!fs.existsSync(sourcePath)) {
  fail(`Source binary not found at ${sourcePath}. Run 'bun packages/opencode/script/build.ts --single --skip-install' from workspace root first.`)
}

try {
  fs.accessSync(sourcePath, fs.constants.X_OK)
} catch {
  fail(`Source binary at ${sourcePath} is not executable. Check permissions.`)
}

const computedSha256 = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex")
const sha256 = (() => {
  if (entry.sha256 === computedSha256) return computedSha256
  if (!rewriteSha256) {
    fail(`sha256 mismatch for ${platform}: expected ${entry.sha256}, got ${computedSha256}. Rebuild the binary, or re-run with --rewrite-sha256.`)
  }
  const oldSha256 = entry.sha256
  entry.sha256 = computedSha256
  fs.writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`)
  fs.renameSync(`${manifestPath}.tmp`, manifestPath)
  console.log(`[vendor-opencode-backend] manifest sha256 rewritten for ${platform}: ${oldSha256} → ${computedSha256}`)
  return computedSha256
})()

const destinationRoot = path.resolve(scriptDir, "..", "..", ".vendored", "opencode")
const destinationBin = path.join(destinationRoot, "bin")
const destinationPath = path.join(destinationBin, process.platform === "win32" ? "opencode.exe" : "opencode")

fs.mkdirSync(destinationBin, { recursive: true })
fs.copyFileSync(sourcePath, destinationPath)
if (process.platform !== "win32") fs.chmodSync(destinationPath, 0o755)

fs.writeFileSync(
  path.join(destinationRoot, "VERSION.json"),
  `${JSON.stringify({
    platform,
    commit: manifest.commit,
    commitShort: manifest.commitShort,
    version: manifest.version,
    builtFrom: manifest.builtFrom,
    builtAt: manifest.builtAt,
    sha256,
    vendoredAt: new Date().toISOString(),
    size: fs.statSync(sourcePath).size,
  }, null, 2)}\n`,
)

console.log(`[vendor-opencode-backend] copied ${path.relative(workspaceRoot, sourcePath)} → ${path.relative(workspaceRoot, destinationPath)} (sha256 OK, version ${manifest.version})`)
