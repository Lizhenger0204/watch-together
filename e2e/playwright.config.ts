import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { loadEnv } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const webDirectory = fileURLToPath(new URL("../apps/web", import.meta.url));
const env = loadEnv("development", webDirectory, "WEB_PORT");
const baseURL = `http://localhost:${env.WEB_PORT ?? 5173}`;
const chromeSpecs = /(source|layout|p2p-[\w-]+|relay-[\w-]+)\.spec\.ts$/;

export default defineConfig({
  testDir: ".",
  use: { baseURL },
  projects: [
    {
      name: "chromium",
      testIgnore: chromeSpecs,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chrome",
      testMatch: chromeSpecs,
      // 避免多組 Chrome 同時競爭本機的影音編解碼資源。
      workers: 1,
      timeout: 60_000,
      expect: { timeout: 10_000 },
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: {
    command: "pnpm dev",
    cwd: root,
    url: `${baseURL}/api/health`,
    timeout: 60_000,
    gracefulShutdown: { signal: "SIGINT", timeout: 1_000 },
  },
});
