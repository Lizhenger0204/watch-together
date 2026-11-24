import { test as base, type BrowserContext, type Page } from "@playwright/test";

export type NewRoomPage = () => Promise<Page>;

export const test = base.extend<{ newRoomPage: NewRoomPage }>({
  newRoomPage: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    try {
      await use(async () => {
        const context = await browser.newContext();
        contexts.push(context);
        // 三方都在本機，保留真實的信令與 ICE 協商，只使用 host candidates。
        await context.route("**/api/rooms/*/ice", (route) =>
          route.fulfill({ json: { iceServers: [] } }),
        );
        await context.route(/\/api\/rooms\/[^/]+\/(whip|whep)\b/, (route) =>
          route.abort(),
        );
        return context.newPage();
      });
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  },
});
