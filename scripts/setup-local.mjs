#!/usr/bin/env node
/**
 * setup:local - prepare a zero-cost local development environment.
 *
 * What it does:
 *   1. Verifies Node/pnpm versions.
 *   2. Picks a free TCP port (no hardcoded port) and records it in .env.
 *   3. Starts an embedded PostgreSQL in a project-local data directory
 *      (binaries come from the public npm registry; no system install, no
 *      Docker daemon required, no paid service).
 *   4. Creates the application database if missing.
 *   5. Runs Prisma migrations.
 *   6. Generates a random SESSION_SECRET and writes .env.
 *   7. Seeds a DEMO tenant with synthetic data (clearly marked DEMO).
 *
 * It never: installs system packages, modifies the OS, starts a public
 * listener on an external interface, or contacts a paid service.
 */
import { execSync, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, symlinkSync, lstatSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// embedded-postgres ships a CJS build; unwrap the interop default.
const pgkModule = require("embedded-postgres");
const pgk = typeof pgkModule === "function" ? pgkModule : pgkModule.default;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const envPath = join(root, ".env");
const envExamplePath = join(root, ".env.example");
const pgDataDir = join(root, ".pgdata");
const storageDir = join(root, ".storage");
const backupsDir = join(root, "backups");

const DEFAULT_PG_PORT = 55432;

function log(msg) {
  console.log(`[setup] ${msg}`);
}

function fail(msg, code = 1) {
  console.error(`[setup] ERROR: ${msg}`);
  process.exit(code);
}

function run(cmd, opts = {}) {
  log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root, ...opts });
}

/** Find a free TCP port, preferring the default. */
function isFree(port) {
  return new Promise((resolve) => {
    const srv = createConnection({ host: "127.0.0.1", port })
      .once("error", () => resolve(true))
      .once("connect", () => {
        srv.destroy();
        resolve(false);
      });
  });
}

async function pickPort(preferred) {
  if (await isFree(preferred)) return preferred;
  for (let p = preferred + 1; p < preferred + 50; p += 1) {
    if (await isFree(p)) return p;
  }
  return 0; // ephemeral
}

/**
 * The published macOS binaries reference ICU/zlib/zstd/lz4 by their
 * "major-only" dylib names (e.g. libicudata.77.dylib) while the package only
 * ships the fully-versioned files (libicudata.77.1.dylib). On a stock macOS
 * install dyld therefore fails with "Library not loaded".
 *
 * The fix is local and reversible: create the missing alias symlinks inside
 * node_modules. No system directory is touched, nothing is deleted, and the
 * symlinks are recreated on every setup run so a fresh `pnpm install` also
 * works.
 */
function repairBundledDylibAliases() {
  let nativeDir = null;
  try {
    nativeDir = join(dirname(require.resolve("embedded-postgres/package.json")), "..");
  } catch {
    return; // package not installed yet
  }
  // The platform package is a sibling dependency: <root>/@embedded-postgres/<platform>
  for (const plat of ["darwin-x64", "darwin-arm64"]) {
    const libDir = join(nativeDir, "@embedded-postgres", plat, "native", "lib");
    if (!existsSync(libDir)) continue;
    let created = 0;
    for (const file of readdirSync(libDir)) {
      if (!file.endsWith(".dylib")) continue;
      const base = file.slice(0, -".dylib".length);
      // full version: libzstd.1.5.7 -> major: libzstd.1 -> bare: libzstd
      const majorMatch = base.match(/^(.*\.\d+)\.\d+(\.\d+)?$/);
      const aliases = [];
      if (majorMatch) aliases.push(`${majorMatch[1]}.dylib`);
      const bareMatch = base.match(/^(.*)\.\d+(\.\d+)*$/);
      if (bareMatch) aliases.push(`${bareMatch[1]}.dylib`);
      for (const alias of aliases) {
        const target = join(libDir, alias);
        if (existsSync(target)) continue;
        try {
          symlinkSync(file, target);
          created += 1;
        } catch {
          /* a racing process may have created it; ignore */
        }
      }
    }
    if (created > 0) log(`created ${created} local dylib alias symlink(s) for ${plat}`);
  }
}

async function main() {
  log("Open Import OS local setup (zero-cost, local-only)");

  // --- 1. toolchain -------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) fail(`Node >= 20 required, found ${process.versions.node}`);
  log(`Node ${process.versions.node} OK`);

  // --- 2. port ------------------------------------------------------------
  const pgPort = await pickPort(DEFAULT_PG_PORT);
  log(`PostgreSQL port: ${pgPort}`);
  const appPort = await pickPort(57831);
  log(`App port: ${appPort}`);

  // --- 3. .env ------------------------------------------------------------
  if (!existsSync(envPath)) {
    if (!existsSync(envExamplePath)) fail(".env.example missing");
    let env = readFileSync(envExamplePath, "utf8");
    const secret = randomBytes(48).toString("base64url");
    const webhookSecret = randomBytes(32).toString("base64url");
    env = env
      .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:${pgPort}/open_import_os`)
      .replace(/^RESTORE_VERIFY_DATABASE_URL=.*$/m, `RESTORE_VERIFY_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:${pgPort}/open_import_os_restore_check`)
      .replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${secret}`)
      .replace(/^WEBHOOK_SIGNING_SECRET=.*$/m, `WEBHOOK_SIGNING_SECRET=${webhookSecret}`)
      .replace(/^APP_BASE_URL=.*$/m, `APP_BASE_URL=http://127.0.0.1:${appPort}`);
    writeFileSync(envPath, env, { mode: 0o600 });
    log(`.env written (mode 0600, secrets generated locally)`);
  } else {
    log(".env already exists - keeping existing secrets and DATABASE_URL");
  }

  mkdirSync(storageDir, { recursive: true });
  mkdirSync(backupsDir, { recursive: true });
  if (!existsSync(join(backupsDir, ".gitkeep"))) writeFileSync(join(backupsDir, ".gitkeep"), "");

  // Prisma reads .env from its own package directory.
  const dbEnvLink = join(root, "packages", "db", ".env");
  if (!existsSync(dbEnvLink)) {
    symlinkSync(join("..", "..", ".env"), dbEnvLink);
    log("linked packages/db/.env -> ../../.env (Prisma reads it from there)");
  }

  // --- 4. embedded PostgreSQL --------------------------------------------
  repairBundledDylibAliases();

  const pg = new pgk({
    databaseDir: pgDataDir,
    user: "postgres",
    password: "postgres",
    port: pgPort,
    persistent: true,
  });

  try {
    if (!existsSync(join(pgDataDir, "PG_VERSION"))) {
      log("initialising local PostgreSQL data directory (one-time download of binaries)");
      await pg.initialise();
    }
    log("starting local PostgreSQL");
    await pg.start();
  } catch (e) {
    fail(`could not start local PostgreSQL: ${e.message}`);
  }

  const { default: pgClient } = await import("pg");
  const admin = new pgClient.Client({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${pgPort}/postgres`,
  });
  await admin.connect();
  const dbName = "open_import_os";
  const exists = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
  if (exists.rowCount === 0) {
    await admin.query(`create database ${dbName}`);
    log(`database ${dbName} created`);
  } else {
    log(`database ${dbName} already present`);
  }
  const restoreDb = "open_import_os_restore_check";
  const restoreExists = await admin.query("select 1 from pg_database where datname = $1", [restoreDb]);
  if (restoreExists.rowCount === 0) {
    await admin.query(`create database ${restoreDb}`);
    log(`database ${restoreDb} created (used only by restore:verify)`);
  }
  await admin.end();

  // --- 5. migrations ------------------------------------------------------
  log("running Prisma generate + migrate deploy");
  run("pnpm --filter @open-import-os/db exec prisma generate");
  run("pnpm --filter @open-import-os/db exec prisma migrate deploy");

  // --- 6. seed ------------------------------------------------------------
  log("seeding DEMO data");
  run("pnpm --filter @open-import-os/db exec tsx prisma/seed.ts");

  log("setup complete. Start the stack with: pnpm dev");
  log(`  web     http://127.0.0.1:${appPort}`);
  log("  worker  http://127.0.0.1:" + (appPort + 1) + "/health/ready");
  log("");
  log("The initial owner account is printed by the seed step (one-time random");
  log("password). DEMO data is always labelled DEMO and never mixed with real data.");
  log("");
  log("Leaving the local PostgreSQL running so `pnpm dev` can attach to it.");
}

main().catch((e) => fail(e.message));
