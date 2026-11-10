// Project evidence scaffold and upload metadata for Scan.
import fs from "node:fs";
import path from "node:path";
import { writeAtomic, mkdirp } from "./fsutil.js";

export const README = `# .intent

Project knowledge and evidence from explicitly requested Scans and proofs.
Commit this folder with the source; do not blanket-ignore it.

- prove/<target>/: proof inputs, scope and PROOF.md; prove/sessions/ is local CLI state.
- scan/<task-id>/: collected report.json and meta.json with source hashes and collection status.
- NOTES.md: confirmed intended behaviour, included in later scans.

Scan commands wait for completion and save results. Use collect to resume an interrupted
Scan without resubmitting source. No automatic hooks or reviews run. Supporting Scan files remain remote.

Transient .queue, .sent.log and .storage.lock files are not committed.
The sent log records upload metadata, never source contents. Old queues are not consumed.
`;

export function ensureScaffold(root) {
  const dir = path.join(root, ".intent");
  let isLink = false;
  try { isLink = fs.lstatSync(dir).isSymbolicLink(); } catch { /* not there yet */ }
  if (isLink) throw new Error(".intent is a symlink");
  mkdirp(dir);
  const put = (name, content) => {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) writeAtomic(f, content);
  };
  put("README.md", README);
  // Keeps .intent/ out of ripgrep-based agent search while git still tracks it.
  put(".ignore", "*\n");
  put(".gitignore", ".sent.log\n.queue\n.storage.lock\n");
}

// The deepest existing ancestor of an evidence directory must resolve inside .intent/.
export function insideIntent(root, dir) {
  const base = fs.realpathSync(path.join(root, ".intent"));
  let p = dir;
  while (!fs.existsSync(p)) p = path.dirname(p);
  const real = fs.realpathSync(p);
  return real === base || real.startsWith(base + path.sep);
}

// One JSON line per upload: paths, bytes, time, URL. Never contents.
export function appendSentLog(root, entry) {
  try {
    ensureScaffold(root);
    appendNoFollow(path.join(root, ".intent", ".sent.log"), JSON.stringify(entry) + "\n");
  } catch { /* read-only repo: skip */ }
}

// Append to a regular file only: a symlink planted at this path is refused.
export function appendNoFollow(file, text) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink > 1) return false;
  } catch { /* does not exist yet */ }
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags, 0o644);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) return false;
    fs.writeSync(fd, text);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}
