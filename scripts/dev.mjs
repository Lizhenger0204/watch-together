import concurrently from "concurrently";

const { result } = concurrently(
  [
    { command: "pnpm --filter @project/web dev", name: "web" },
    { command: "pnpm --filter @project/signal dev", name: "signal" },
  ],
  { killOthersOn: ["success", "failure"] },
);

try {
  await result;
} catch {
  process.exitCode = 1;
}
