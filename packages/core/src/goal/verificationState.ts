/** Content, not report spelling, commit ids or file timestamps, determines whether a check can be reused. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SKIP = new Set([".git", ".cursor", "node_modules", ".venv", "venv", "vendor", "__pycache__", ".cache"]);
const MAX_FILES = 20_000;
const MAX_BYTES = 300 * 1024 * 1024;

/** Null means the relevant local state could not be bounded/read: callers must not reuse a verdict. */
export function verificationState(root: string): string | null {
  const began = Date.now();
  const files = new Set<string>();
  const absent = new Set<string>();
  let bytes = 0;
  const inside = (rel: string): string => {
    const full = path.resolve(root, rel);
    if (full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) throw new Error("outside project");
    return full;
  };
  const walk = (rel: string): void => {
    if (Date.now() - began > 3000 || files.size > MAX_FILES) throw new Error("too large");
    const full = inside(rel);
    const st = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!st) { absent.add(rel); return; }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(full)) if (!SKIP.has(name)) walk(path.join(rel, name));
    } else files.add(rel);
  };
  try {
    const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", timeout: 3000, maxBuffer: 20_000_000, windowsHide: true });
    if (listed.status === 0 && !listed.error) {
      for (const rel of listed.stdout.split("\0").filter(Boolean)) {
        if (rel === ".cursor" || rel.startsWith(".cursor/")) continue;
        if (files.size >= MAX_FILES) throw new Error("too large");
        const st = fs.lstatSync(inside(rel), { throwIfNoEntry: false });
        if (st && !st.isDirectory()) files.add(rel);
      }
    } else walk("");
    // Generated public entries can be ignored by git yet still change package behavior.
    for (const dir of ["dist", "build", "target", "out"]) walk(dir);
    const manifestPath = path.join(root, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const entries = (v: unknown): void => {
        if (typeof v === "string") {
          if (!v.startsWith(".") && !v.includes("/") && !v.includes(".")) return;
          const star = v.indexOf("*");
          const prefix = star >= 0 ? v.slice(0, star) : v;
          walk(star >= 0 && !prefix.endsWith("/") ? path.dirname(prefix) : prefix);
        } else if (v && typeof v === "object") for (const item of Object.values(v)) entries(item);
      };
      for (const key of ["main", "module", "browser", "types", "typings", "exports", "bin"]) entries(manifest[key]);
    }
    // Installation metadata complements the project's own manifests/lockfiles without hashing dependency caches.
    for (const rel of ["node_modules/.package-lock.json", "node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml", ".venv/pyvenv.cfg"]) {
      if (fs.existsSync(path.join(root, rel))) files.add(rel);
    }
    const hash = createHash("sha256");
    for (const rel of [...files].sort()) {
      if (Date.now() - began > 3000) return null;
      const full = inside(rel), st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        const target = fs.realpathSync(full);
        if (!target.startsWith(path.resolve(root) + path.sep) || !fs.statSync(target).isFile()) return null;
        hash.update(JSON.stringify([rel, "link", fs.readlinkSync(full)]));
      }
      const size = st.isSymbolicLink() ? fs.statSync(full).size : st.size;
      if (bytes + size > MAX_BYTES || files.size > MAX_FILES) return null;
      const content = fs.readFileSync(full);
      bytes += content.length;
      if (bytes > MAX_BYTES) return null;
      hash.update(JSON.stringify([rel.replace(/\\/g, "/"), st.mode & 0o777, content.length]));
      hash.update(content);
    }
    for (const rel of [...absent].sort()) hash.update(JSON.stringify([rel, "absent"]));
    return hash.digest("hex");
  } catch { return null; }
}
