import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { seedDb } from "./seed.js";
import type { Db } from "./types.js";

/** JSON-file persistence. Fine for a single-process demo; a real backend would use a DB. */
export class JsonStore {
  constructor(private readonly file: string) {}

  load(): Db {
    if (!existsSync(this.file)) return this.reset();
    return JSON.parse(readFileSync(this.file, "utf8")) as Db;
  }

  save(db: Db): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(db, null, 2));
  }

  reset(): Db {
    const db = seedDb();
    this.save(db);
    return db;
  }
}
