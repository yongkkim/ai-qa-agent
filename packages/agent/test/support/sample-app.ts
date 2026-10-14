import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE_APP = resolve(here, "../../../../apps/sample-app");

export interface BuiltApp {
  js: string;
  css: string;
  /** Folder with the built index.html + assets, for serving to a real browser. */
  dir: string;
}

const cache = new Map<string, Promise<BuiltApp>>();

/** Builds the real sample app (normal or with planted bugs) once per test process. */
export function buildSampleApp(mode: "normal" | "buggy"): Promise<BuiltApp> {
  if (!cache.has(mode)) {
    cache.set(
      mode,
      (async () => {
        const { build } = await import("vite");
        const outDir = join(tmpdir(), `ai-qa-sample-app-${mode}-${process.pid}`);
        mkdirSync(outDir, { recursive: true });
        await build({
          root: SAMPLE_APP,
          configFile: join(SAMPLE_APP, "vite.config.ts"),
          mode: mode === "buggy" ? "buggy" : "production",
          logLevel: "silent",
          build: { outDir, emptyOutDir: true },
        });
        const assets = join(outDir, "assets");
        if (!existsSync(assets)) throw new Error("sample app build produced no assets");
        const files = readdirSync(assets);
        return {
          dir: outDir,
          js: readFileSync(join(assets, files.find((f) => f.endsWith(".js"))!), "utf8"),
          css: readFileSync(join(assets, files.find((f) => f.endsWith(".css"))!), "utf8"),
        };
      })(),
    );
  }
  return cache.get(mode)!;
}
