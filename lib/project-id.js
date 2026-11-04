import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./fsutil.js";

export const isProjectId = id => typeof id === "string" && /^[a-z0-9]{6}$/.test(id);

export function projectId(root) {
  const used = new Set();
  const remember = value => {
    if (isProjectId(value)) used.add(value);
    else if (Array.isArray(value)) value.forEach(remember);
    else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) { remember(key); remember(entry); }
    }
  };
  const visit = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "specs" && fs.existsSync(path.join(dir, "index.json"))) {
          for (const bundle of fs.readdirSync(file)) remember(bundle);
        } else visit(file);
      } else if (entry.isFile() && ["requirements.json", "index.json"].includes(entry.name)) {
        remember(JSON.parse(fs.readFileSync(file, "utf8")));
      }
    }
  };
  visit(path.join(root, ".intent", "source"));
  const logs = path.join(root, ".intent", "logs");
  if (fs.existsSync(logs)) for (const entry of fs.readdirSync(logs, { withFileTypes: true })) {
    remember(entry.name);
    if (entry.isDirectory()) remember(readJson(path.join(logs, entry.name, "request.json"), null));
  }
  for (;;) {
    const id = crypto.randomInt(36 ** 6).toString(36).padStart(6, "0");
    if (!used.has(id)) return id;
  }
}

// Server task IDs stay unchanged; local folder IDs are recorded independently.
export function operationDir(root, taskId) {
  const logs = path.join(root, ".intent", "logs");
  if (fs.existsSync(logs) && fs.lstatSync(logs).isSymbolicLink()) throw new Error("logs must be a real directory");
  fs.mkdirSync(logs, { recursive: true });
  for (const entry of fs.readdirSync(logs, { withFileTypes: true })) {
    if (entry.isDirectory() && isProjectId(entry.name)
        && readJson(path.join(logs, entry.name, "request.json"), null)?.task_id === taskId) {
      return path.join(logs, entry.name);
    }
  }
  for (;;) {
    const dir = path.join(logs, projectId(root));
    try { fs.mkdirSync(dir); }
    catch (error) { if (error.code === "EEXIST") continue; throw error; }
    writeJsonAtomic(path.join(dir, "request.json"), { version: 1, task_id: taskId });
    return dir;
  }
}
