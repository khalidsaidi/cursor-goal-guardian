import fs from "node:fs";
import path from "node:path";

/** A process-owned lease; a crashed owner's file cannot permanently disable background work. */
export function processLease(file: string): (() => void) | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try { fd = fs.openSync(file, "wx"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(file), pid = Number(fs.readFileSync(file, "utf8"));
        let stale = false;
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (e) { stale = (e as NodeJS.ErrnoException).code === "ESRCH"; }
        } else stale = Date.now() - stat.mtimeMs > 600_000;
        if (stale && fs.statSync(file).ino === stat.ino) { fs.unlinkSync(file); continue; }
      } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
      return null;
    }
    try { fs.writeFileSync(fd, String(process.pid)); }
    catch (e) { fs.closeSync(fd); fs.unlinkSync(file); throw e; }
    const inode = fs.fstatSync(fd).ino;
    return () => {
      fs.closeSync(fd);
      try { if (fs.statSync(file).ino === inode) fs.unlinkSync(file); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    };
  }
  return null;
}
