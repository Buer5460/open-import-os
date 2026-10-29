import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    // Money math must never be silently parallel-modified; keep tests isolated.
    pool: "forks",
  },
});
