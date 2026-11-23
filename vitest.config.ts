import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/web/**/*.{test,spec}.ts?(x)",
      "packages/**/*.{test,spec}.ts?(x)",
    ],
  },
});
