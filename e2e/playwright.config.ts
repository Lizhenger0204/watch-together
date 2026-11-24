import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { loadEnv } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const webDirectory = fileURLToPath(new URL("../apps/web", import.meta.url));
const env = loadEnv("development", webDirectory, "WEB_PORT");
const baseURL = `http://localhost:${env.WEB_PORT ?? 5173}`;

export default defineConfig({
  testDir: ".",
  use: { baseURL },
  projects: [
    {
      name: "chromium",
      testIgnore: /(source|layout)\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chrome",
      testMatch: /(source|layout)\.spec\.ts$/,
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
