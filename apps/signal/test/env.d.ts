import type { Env as WorkerEnv } from "../src/runtime/workers/env";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 擴充全域 Env 型別
    interface Env extends WorkerEnv {}
  }
}
