import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { z } from "zod";

const port = z.coerce.number().int().min(1).max(65535);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ["WEB_PORT", "SIGNAL_PORT"]);
  const webPort = port.parse(env.WEB_PORT ?? 5173);
  const signalPort = port.parse(env.SIGNAL_PORT ?? 8787);

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: webPort,
      strictPort: true,
      proxy: {
        "/api": { target: `http://127.0.0.1:${signalPort}`, ws: true },
      },
    },
  };
});
