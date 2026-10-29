#!/usr/bin/env node
/**
 * dev - start the local stack with a real embedded PostgreSQL.
 *
 * Prints the ACTUAL URLs it is serving (never a placeholder). If the database
 * data directory does not exist yet, tells the user to run `pnpm setup:local`
 * rather than silently starting a half-broken stack.
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const pgDataDir = join(root, ".pgdata");

if (!existsSync(join(pgDataDir, "PG_VERSION"))) {
  console.error("[dev] no local database found. Run `pnpm setup:local` first.");
  process.exit(1);
}

if (!existsSync(join(root, ".env"))) {
  console.error("[dev] no .env found. Run `pnpm setup:local` first.");
  process.exit(1);
}

const { default: pgk } = await import("embedded-postgres");
const port = Number(new URLSearchParams(readEnv().toString()).get("PG_PORT") ?? 55432);

function readEnv() {
  const { readFileSync } = require("node:fs");
  return readFileSync(join(root, ".env"), "utf8");
}

const pg = new pgk({
  databaseDir: pgDataDir,
  user: "postgres",
  password: "postgres",
  port,
  persistent: true,
});

await pg.start();
console.log(`[dev] local PostgreSQL started on 127.0.0.1:${port}`);

const { spawn } = await import("node:child_process");
const children = [];

function start(name, cmd, args, portHint) {
  const c = spawn(cmd, args, { cwd: root, stdio: "inherit", env: process.env });
  children.push(c);
  c.on("exit", (code) => {
    console.log(`[dev] ${name} exited with code ${code}`);
  });
  console.log(`[dev] ${name} -> http://127.0.0.1:${portHint}`);
}

start("web", "pnpm", ["--filter", "@open-import-os/web", "dev"], port);
start("worker", "pnpm", ["--filter", "@open-import-os/worker", "dev"], port + 1);

function shutdown() {
  for (const c of children) c.kill("SIGTERM");
  pg.stop().then(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
