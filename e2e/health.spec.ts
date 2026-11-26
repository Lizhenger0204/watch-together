import { expect, test } from "@playwright/test";
import { PROTOCOL_VERSION } from "../packages/shared/src/constants";

test("首頁顯示服務狀態", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText(
    `服務正常（協定版本 ${PROTOCOL_VERSION}）`,
  );
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("health.png") });
});
