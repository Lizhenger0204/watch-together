import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, resolve } from "node:path";

const requireSignal = createRequire(
  resolve(import.meta.dirname, "../apps/signal/package.json"),
);
const { z } = requireSignal("zod");
const port = z
  .string()
  .regex(/^\d+$/)
  .pipe(z.coerce.number().int().min(1).max(65535))
  .safeParse(process.env.SIGNAL_PORT ?? "8787");

if (!port.success) {
  process.stderr.write("SIGNAL_PORT 必須是 1 到 65535 之間的整數。\n");
  process.exit(1);
}

// 直接用 Node 執行套件宣告的 CLI，路徑含空白也不必交給 cmd.exe 展開。
const manifestPath = requireSignal.resolve("wrangler/package.json");
const cli = resolve(
  dirname(manifestPath),
  requireSignal(manifestPath).bin.wrangler,
);
const child = spawn(
  process.execPath,
  [cli, "dev", "--port", String(port.data), ...process.argv.slice(2)],
  { stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    if (process.platform === "win32") {
      // Windows 的 child.kill() 只會強制終止直接子程序，Wrangler 還啟動了 workerd。
      execFile(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        (error) => {
          if (error && child.exitCode === null && child.signalCode === null) {
            process.stderr.write("無法結束 Wrangler 的程序樹。\n");
          }
        },
      );
    } else {
      child.kill(signal);
    }
  });
}

child.on("error", (error) => {
  process.stderr.write(`Wrangler 子程序錯誤：${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? 128 + constants.signals[signal];
});
