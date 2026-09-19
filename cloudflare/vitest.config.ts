import { resolve } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    main: resolve(import.meta.dirname, "src/index.ts"),
    wrangler: { configPath: resolve(import.meta.dirname, "wrangler.jsonc") },
    miniflare: {
      bindings: {
        ENVIRONMENT: "test",
        ISSUER_JWK: "test",
        SESSION_WRAP_KEY: "test",
        REGISTRATION_TOKEN: "test-registration",
        MAX_BODY_BYTES: "131072",
        HEARTBEAT_MIN_SECONDS: "0",
        TEST_MIGRATIONS: await readD1Migrations(resolve(import.meta.dirname, "migrations")),
      },
    },
  }))],
  test: { include: [resolve(import.meta.dirname, "test/**/*.cf.ts")], setupFiles: [resolve(import.meta.dirname, "test/setup.ts")] },
});
