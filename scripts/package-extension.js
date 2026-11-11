#!/usr/bin/env node
// Package a platform-targeted VSIX carrying the self-contained native
// binaries for exactly that platform:
//
//   node scripts/package-extension.js                    # host platform
//   node scripts/package-extension.js --target win32-x64 # explicit target
//
// Produces cursor-goal-guardian-<target>.vsix (and copies the host build to
// cursor-goal-guardian.vsix for local install convenience).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const extDir = path.join(root, "packages", "cursor-goal-guardian-extension");
const binDir = path.join(extDir, "bin");

function hostTarget() {
  const plat = os.platform();
  const arch = os.arch() === "arm64" ? "arm64" : "x64";
  return `${plat === "win32" ? "win32" : plat === "darwin" ? "darwin" : "linux"}-${arch}`;
}

const targetFlag = process.argv.indexOf("--target");
const target = targetFlag >= 0 ? process.argv[targetFlag + 1] : hostTarget();

run("pnpm", ["--filter", "@goal-guardian/core", "build"], root);
run("pnpm", ["--filter", "cursor-goal-guardian-extension", "build"], root);

// Always compile fresh — a stale dist-bin once shipped an hour-old binary.
const compiled = path.join(root, "dist-bin", target);
if (target === hostTarget()) run("node", [path.join(root, "scripts", "compile-binaries.mjs"), "--host-only"], root);
else run("node", [path.join(root, "scripts", "compile-binaries.mjs")], root);
await fs.rm(binDir, { recursive: true, force: true });
await fs.mkdir(binDir, { recursive: true });
for (const entry of await fs.readdir(compiled)) {
  await fs.copyFile(path.join(compiled, entry), path.join(binDir, entry));
  if (!target.startsWith("win32")) await fs.chmod(path.join(binDir, entry), 0o755);
}

// Google's RRSI and Google ADK's evaluator run as they are, in Python, so the VSIX carries a Python of its own: python-build-standalone,
// pinned and checksum-verified, like the binaries above. Nothing is downloaded on the user's machine.
const PYTHON_RELEASE = "20261026";
const PYTHON_VERSION = "3.12.16";
const PYTHON_BUILDS = {
  "linux-x64": ["x86_64-unknown-linux-gnu", "ce4f6d0a6cfdb3bed6e44c2f9affd85943c76a42e25ad3a259002f31d6fb8a20"],
  "linux-arm64": ["aarch64-unknown-linux-gnu", "bb4b6392670c5d3f93876996fcaa19858a4a413a0c7720144c18b0d6f1f0db2d"],
  "darwin-x64": ["x86_64-apple-darwin", "37c38fda76fec1fbf310adcbafb7f0d96af13b5511bf8ea954c3aa8eec185734"],
  "darwin-arm64": ["aarch64-apple-darwin", "353d5f1b4fd2715e7053f12f068435d5bbad16b91e057006b5d01e0925709a7e"],
  "win32-x64": ["x86_64-pc-windows-msvc", "1f2ab53880fc67ea323398c6388e05af28addc99a8e389209f08a51fdff4b149"],
  "win32-arm64": ["aarch64-pc-windows-msvc", "3b2e4da9209cec3e0eaf4db31176977a88df32d598ff94a7899c34cd8304db04"],
};

async function bundlePython() {
  const build = PYTHON_BUILDS[target];
  if (!build) throw new Error(`no Python build pinned for ${target}`);
  const [triple, sha256] = build;
  const file = `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-${triple}-install_only_stripped.tar.gz`;
  const cacheDir = path.join(root, ".cache", "python");
  const archive = path.join(cacheDir, file);
  await fs.mkdir(cacheDir, { recursive: true });
  const digest = async () => createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  if (!(await fs.access(archive).then(() => true, () => false)) || (await digest()) !== sha256) {
    const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/${encodeURIComponent(file)}`;
    run("curl", ["-fsSL", "--retry", "4", "--retry-delay", "2", "--retry-all-errors", "-o", archive, url], root);
  }
  const got = await digest();
  if (got !== sha256) throw new Error(`${file}: checksum ${got} does not match the pinned ${sha256}`);
  // The archive's top folder is python/: it lands at bin/python.
  run("tar", ["-xzf", archive, "-C", binDir], root);
  await prunePython(path.join(binDir, "python"));
}

/**
 * RRSI needs only the standard library. GUI toolkits, pip, headers, docs, the test suite and the terminal database
 * go: they triple the size, and the terminal database's case-only name clashes are something a VSIX can't hold.
 */
async function prunePython(py) {
  const lib = target.startsWith("win32") ? "Lib" : path.join("lib", "python3.12");
  const drop = [
    "share", "include", "libs", "Scripts", "tcl",
    ...["idlelib", "tkinter", "turtledemo", "ensurepip", "lib2to3", "pydoc_data", "test", "site-packages"].map((d) => path.join(lib, d)),
  ];
  const dropMatching = {
    lib: /^(pkgconfig|tcl\d.*|tk\d.*|itcl.*|thread\d.*|libtcl.*|libtk.*)$/,
    bin: /^(2to3.*|idle3.*|pip.*|pydoc3.*|python3.*-config)$/,
    DLLs: /^(_tkinter.*|tcl\d.*|tk\d.*)$/i,
    [path.join(lib, "lib-dynload")]: /^_tkinter/,
    [lib]: /^config-3\.12/,
  };
  // Linux's interpreter is statically linked; the shared library is only for embedding.
  if (target.startsWith("linux")) dropMatching.lib = /^(pkgconfig|tcl\d.*|tk\d.*|itcl.*|thread\d.*|libtcl.*|libtk.*|libpython3.*)$/;
  for (const d of drop) await fs.rm(path.join(py, d), { recursive: true, force: true });
  for (const [dir, re] of Object.entries(dropMatching)) {
    const names = await fs.readdir(path.join(py, dir)).catch(() => []);
    for (const n of names.filter((x) => re.test(x))) await fs.rm(path.join(py, dir, n), { recursive: true, force: true });
  }
  await fs.mkdir(path.join(py, lib, "site-packages"), { recursive: true });
}

/** RRSI unmodified, Guardian's domain for it, and the NOTICE crediting it. */
async function bundleRsi() {
  const rsiDir = path.join(extDir, "rsi");
  await fs.rm(rsiDir, { recursive: true, force: true });
  const skip = (src) => !/(^|[\\/])(__pycache__|tests)([\\/]|$)/.test(src);
  const vendored = path.join(root, "third_party", "rrsi");
  await fs.cp(vendored, path.join(rsiDir, "rrsi"), { recursive: true, filter: (src) => skip(path.relative(vendored, src)) });
  const domain = path.join(root, "packages", "rsi", "cgg");
  await fs.cp(domain, path.join(rsiDir, "cgg"), { recursive: true, filter: (src) => skip(path.relative(domain, src)) });
  await fs.copyFile(path.join(root, "NOTICE"), path.join(extDir, "NOTICE"));
}

/**
 * Google ADK's evaluator: its own files unmodified (third_party/adk-python), Guardian's adapter, and the packages
 * ADK depends on, pinned in packages/evaluator/requirements.txt and installed as wheels for the target platform.
 * It runs on the same bundled Python. Only linux-x64 is wired for now; other targets ship without the evaluator,
 * which the code tolerates (the second check is recorded as skipped).
 */
const PIP_PLATFORMS = { "linux-x64": ["manylinux2014_x86_64", "manylinux_2_17_x86_64", "manylinux_2_28_x86_64"] };

async function bundleEvaluator() {
  const home = path.join(extDir, "evaluator");
  await fs.rm(home, { recursive: true, force: true });
  // What an earlier second check left in a development tree.
  await fs.rm(path.join(extDir, "monitor"), { recursive: true, force: true });
  const platforms = PIP_PLATFORMS[target];
  if (!platforms) {
    console.log(`evaluator: not bundled for ${target} yet`);
    return;
  }
  const skip = (src) => !/(^|[\\/])(__pycache__|tests|tools|\.site)([\\/]|$)/.test(src);
  const adapter = path.join(root, "packages", "evaluator", "cgg_evaluator");
  await fs.cp(adapter, path.join(home, "cgg_evaluator"), { recursive: true, filter: (src) => skip(path.relative(adapter, src)) });
  const vendored = path.join(root, "third_party", "adk-python");
  await fs.cp(path.join(vendored, "src"), path.join(home, "adk"), { recursive: true, filter: (src) => !/(^|[\\/])__pycache__([\\/]|$)/.test(src) });
  await fs.copyFile(path.join(vendored, "LICENSE"), path.join(home, "adk", "LICENSE"));
  run("python3", [
    "-m", "pip", "install", "--quiet", "--no-input", "--no-deps", "--only-binary=:all:", "--implementation", "cp", "--python-version", "3.12",
    ...platforms.flatMap((p) => ["--platform", p]),
    "--target", path.join(home, "site-packages"), "-r", path.join(root, "packages", "evaluator", "requirements.txt"),
  ], root);
  // Wheels ship their own test suites, which nothing here runs. google-genai's holds sample tokens that the VSIX
  // packager's secret scan rejects.
  const dropTests = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "tests" || entry.name === "__pycache__") await fs.rm(full, { recursive: true, force: true });
      else await dropTests(full);
    }
  };
  await dropTests(path.join(home, "site-packages"));
}

await bundlePython();
await bundleRsi();
await bundleEvaluator();

const out = `cursor-goal-guardian-${target}.vsix`;
run("pnpm", ["dlx", "@vscode/vsce", "package", "--no-dependencies", "--target", target, "--out", out], extDir);
if (target === hostTarget()) {
  await fs.copyFile(path.join(extDir, out), path.join(extDir, "cursor-goal-guardian.vsix"));
}
console.log(`packaged ${out}`);
