#!/usr/bin/env node
/**
 * pg - start/stop/status for the project-local PostgreSQL.
 *
 * The instance lives in <root>/.pgdata, listens on 127.0.0.1 only, and uses
 * the port recorded in .env (PG_PORT). No system service is registered and
 * no external interface is opened.
 */
import { existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pgkMod = require("embedded-postgres");
const EmbeddedPostgres = typeof pgkMod === "function" ? pgkMod : pgkMod.default;

/**
 * The published macOS binaries reference ICU/zlib/zstd/lz4 by their
 * major-only dylib names while the package ships fully-versioned files.
 * Recreate the missing alias symlinks inside node_modules (local, reversible;
 * a fresh `pnpm install` wipes them, so this runs on every start).
 */
function repairBundledDylibAliases() {
  // embedded-postgres does not export ./package.json; resolve the platform
  // package through its well-known pnpm location instead.
  const candidates = [
    join(root, "node_modules", ".pnpm", "node_modules", "@embedded-postgres"),
    join(root, "node_modules", "@embedded-postgres"),
  ];
  for (const base of candidates) {
    if (!existsSync(base)) continue;
    for (const plat of ["darwin-x64", "darwin-arm64"]) {
      const libDir = join(base, plat, "native", "lib");
      if (!existsSync(libDir)) continue;
      for (const file of readdirSync(libDir)) {
        if (!file.endsWith(".dylib")) continue;
        const name = file.slice(0, -".dylib".length);
        const aliases = [];
        const major = name.match(/^(.*\.\d+)\.\d+(\.\d+)?$/);
        if (major) aliases.push(`${major[1]}.dylib`);
        const bare = name.match(/^(.*)\.\d+(\.\d+)*$/);
        if (bare) aliases.push(`${bare[1]}.dylib`);
        for (const alias of aliases) {
          if (existsSync(join(libDir, alias))) continue;
          try {
            symlinkSync(file, join(libDir, alias));
          } catch {
            /* racing process created it; ignore */
          }
        }
      }
    }
  }
}

function readPort() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return 55432;
  const m = readFileSync(envPath, "utf8").match(/DATABASE_URL=postgresql:\/\/[^:]+:[^@]+@127\.0\.0\.1:(\d+)/);
  return m ? Number(m[1]) : 55432;
}

const action = process.argv[2] ?? "status";
repairBundledDylibAliases();
const port = readPort();
const pg = new EmbeddedPostgres({
  databaseDir: join(root, ".pgdata"),
  user: "postgres",
  password: "postgres",
  port,
  persistent: true,
});

switch (action) {
  case "start": {
    if (!existsSync(join(root, ".pgdata", "PG_VERSION"))) {
      console.error("[pg] no data directory. Run `pnpm setup:local` first.");
      process.exit(1);
    }
    await pg.start();
    console.log(`[pg] PostgreSQL listening on 127.0.0.1:${port}`);
    // Keep the process alive so the server stays up for child processes.
    setInterval(() => {}, 1 << 30);
    break;
  }
  case "stop":
    await pg.stop();
    console.log("[pg] stopped");
    break;
  case "status": {
    const { default: pgClient } = await import("pg");
    const c = new pgClient.Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres` });
    try {
      await c.connect();
      const r = await c.query("select version()");
      console.log(`[pg] UP on 127.0.0.1:${port} - ${r.rows[0].version}`);
      await c.end();
    } catch {
      console.log(`[pg] DOWN on 127.0.0.1:${port}`);
      process.exit(1);
    }
    break;
  }
  default:
    console.error("usage: node scripts/pg.mjs <start|stop|status>");
    process.exit(1);
}
