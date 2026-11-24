import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// 走真實的套件 script 與各平台的 shell，用 --help 驗證參數轉交且不佔用 port。
function signalDevHelp(port) {
  const env = { ...process.env, SIGNAL_PORT: port };
  if (port === undefined) delete env.SIGNAL_PORT;
  const result = spawnSync("pnpm --filter @project/signal run dev --help", {
    env,
    shell: true,
    encoding: "utf8",
  });
  assert.ifError(result.error);
  return result;
}

test("未指定或位於合法邊界的 SIGNAL_PORT 能啟動 Wrangler", () => {
  for (const port of [undefined, "1", "65535"]) {
    const { status, stdout, stderr } = signalDevHelp(port);
    assert.equal(status, 0, stderr);
    assert.match(stdout, /wrangler dev \[script\]/);
  }
});

test("不合法的 SIGNAL_PORT 會在啟動 Wrangler 前報錯", () => {
  for (const port of ["", "0", "65536", "1.5", "9017x"]) {
    const { status, stdout, stderr } = signalDevHelp(port);
    assert.equal(status, 1);
    assert.match(stderr, /SIGNAL_PORT.*1.*65535/);
    assert.doesNotMatch(stdout, /wrangler dev \[script\]/);
  }
});
