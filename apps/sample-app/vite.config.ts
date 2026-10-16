import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Prints which planted bugs are switched on when the dev server starts, so it is obvious
 * in the terminal whether the app under test matches the scenario you meant to run
 * (e.g. after editing .env.buggy but forgetting to restart).
 */
function announcePlantedBugs(bugs: string): Plugin {
  return {
    name: "announce-planted-bugs",
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        const list = bugs.split(",").map((b) => b.trim()).filter(Boolean);
        const msg = list.length ? `\x1b[33mplanted bugs ON: ${list.join(", ")}\x1b[0m` : "\x1b[32mno planted bugs (correct app)\x1b[0m";
        server.config.logger.info(`  [sample-app] ${msg}`);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [react(), announcePlantedBugs(env.VITE_BUGS ?? "")],
  };
});
