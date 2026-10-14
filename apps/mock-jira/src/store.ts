import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DATA_FILE } from "./env.js";
import { seedDb } from "./seed.js";
import type { Db } from "./types.js";

/** JSON-file persistence. Fine for a single-process demo; a real backend would use a DB. */
export function loadDb(): Db {
  if (!existsSync(DATA_FILE)) {
    const db = seedDb();
    saveDb(db);
    return db;
  }
  return JSON.parse(readFileSync(DATA_FILE, "utf8")) as Db;
}

export function saveDb(db: Db): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

export function resetDb(): Db {
  const db = seedDb();
  saveDb(db);
  return db;
}
