# 把遠端同步播放器架到 Cloudflare

完成後，朋友可以用你自己的網址開啟播放器。網頁、房間 API 和 WebSocket 都走同一個 HTTPS 網址。以下用 `watch.example.com` 示範，請換成你實際買到的網域，例如你買了 `my-movie.net`，就用 `watch.my-movie.net`。

## 1. 準備電腦和專案

你需要一台能上網的電腦、一個可收驗證信的信箱，以及購買網域的付款方式。房主開播時請使用電腦版 Chrome 或 Edge。

1. 到 Node.js 官網下載 **22.x** 安裝程式。依 pnpm 官網指示安裝本專案指定的 pnpm 版本，可在專案根目錄的 `package.json` 找到 `packageManager`。[Node.js 下載](https://nodejs.org/en/download) · [pnpm 安裝說明](https://pnpm.io/installation)
2. 取得專案資料夾。如果拿到的是 ZIP 檔，先解壓縮。打開終端機（Windows 用 PowerShell，macOS 用「終端機」），輸入 `cd `，把專案資料夾拖入終端機帶入路徑，按 Enter。這個資料夾裡應該看得到 `package.json`、`pnpm-lock.yaml` 和 `apps`。
3. 逐行執行以下指令。每次按 Enter 後，等指令跑完再輸入下一行。

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
```

前兩行應顯示 `v22.x.x`，以及與 `packageManager` 一致的 pnpm 版本。最後一行應完成安裝並顯示類似 `Done in …` 的訊息。

## 2. 註冊 Cloudflare 帳號

從官方說明打開註冊頁，填入信箱和密碼，按 **Create Account**。到信箱開啟驗證信並完成驗證，再登入 Cloudflare 後台。後面買網域和建立服務都使用這個帳號。[Cloudflare 帳號註冊說明](https://developers.cloudflare.com/fundamentals/account/create-account/)

> 📷 截圖：Cloudflare 註冊頁 → Create Account（待補）

## 3. 買網域

中國大陸通常連不到 `*.workers.dev`，所以本專案使用自己的網域來邀請當地朋友。自訂網址綁好後，請讓朋友用自己的網路實測能否開啟和收看。[中國網路量測研究](https://secretlab.page/publications/block-a-mole-arxiv-2026.pdf) · [Cloudflare 自訂網域說明](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

1. 登入後台並進入 **Register domains** 頁面。用搜尋欄找你想買的名字，再按 **Search**。
2. 找到可用的名字後按 **Purchase**，先看清楚註冊和續約價格，再填聯絡資料和付款。常見尾碼可先抓每年約 **US$10–20**，例如 `.com` 官方價表目前約 **US$11/年**，其他尾碼可能更貴，以結帳價格為準。
3. 收到網域註冊聯絡人的驗證信後，按信中連結完成驗證。[Cloudflare 網域註冊步驟](https://developers.cloudflare.com/registrar/get-started/register-domain/) · [官方價格表](https://pricing.registrar.cloudflare.com/)

> 📷 截圖：Cloudflare 後台 → Register domains → Search → Purchase（待補）

## 4. 讓終端機登入 Cloudflare

回到專案資料夾的終端機，執行下方指令。Wrangler 是專案已安裝的 Cloudflare 命令列工具。它會開啟瀏覽器，讓你用剛才的帳號登入並同意授權。回到終端機後，第二行應列出登入身分及可用帳號。[Wrangler 指令](https://developers.cloudflare.com/workers/wrangler/commands/general/)

```sh
pnpm --filter @project/signal exec wrangler login
pnpm --filter @project/signal exec wrangler whoami
```

> 📷 截圖：Wrangler 開啟的 Cloudflare 瀏覽器授權頁 → 同意授權（待補）

## 5. 取得 Realtime SFU 和 TURN 的機密值

Realtime SFU 是「轉發模式」使用的影音服務。TURN 是直連受網路限制時可使用的中繼服務。可以先略過兩項服務，等第一次部署完成後再設定。

1. 選擇 Cloudflare 帳號，進入 **Realtime → Serverless SFU**，建立一個 app，例如取名 `remote-sync-player`。建立按鈕的實際文字待確認。從應用程式資料取得 **App ID** 和 **App Secret**，分別對應 `REALTIME_APP_ID` 和 `REALTIME_APP_TOKEN`。[Cloudflare SFU 建立說明](https://developers.cloudflare.com/realtime/sfu/get-started/)
2. 從官方 TURN 說明的 **Dashboard** 連結進入 TURN 管理頁，選同一個帳號並建立一把 TURN key。選單層級和建立按鈕文字待確認。保存 **TURN Key ID** 和 **API Token**，分別對應 `TURN_KEY_ID` 和 `TURN_KEY_TOKEN`。[Cloudflare TURN 建立說明](https://developers.cloudflare.com/realtime/turn/generate-credentials/)

> 📷 截圖：Cloudflare 後台 → Realtime → Serverless SFU → 建立 app（待補，遮住機密值）

> 📷 截圖：Cloudflare 官方 TURN 說明 → Dashboard → 建立 TURN key（待補，遮住機密值）

把這些值存在密碼管理器。**別把 token 貼到聊天、截圖、指令參數或 Git**。本機開發時，可複製 `apps/signal/.dev.vars.example` 為同一資料夾的 `apps/signal/.dev.vars`，再把值填在等號後。.dev.vars 已被 Git 忽略。正式站的設定見下一步。[Cloudflare 機密設定說明](https://developers.cloudflare.com/workers/configuration/secrets/)

## 6. 第一次部署並設定機密

用文字編輯器打開 `apps/signal/wrangler.toml`，找 **`[env.production.vars]`** 下的 `PUBLIC_ORIGIN`。把右邊的示範網址換成自己打算綁定的網址，保留引號及 `https://`，結尾省略斜線。上方本機用的 `[vars]` 有另一個 `PUBLIC_ORIGIN`，請在正式環境那一段填寫。

儲存後在專案根目錄執行以下命令。它會先建置網頁，再發布 Worker。成功時應看到類似 `Uploaded remote-sync-player-signal-production` 的訊息。正式站用自訂網址，所以要等下一步綁定網域後才能從瀏覽器開啟。[Wrangler 指令](https://developers.cloudflare.com/workers/wrangler/commands/)

```sh
pnpm deploy
```

如果第 5 步已取得機密，請在 Worker 建立後逐行執行下面指令。每一行都會提示輸入該項目的值。看到提示再貼上對應值並按 Enter，成功時會看到類似 `Success! Uploaded secret …` 的訊息。只使用其中一項服務時，設定該服務的兩個值即可。[Cloudflare 機密設定說明](https://developers.cloudflare.com/workers/configuration/secrets/)

```sh
pnpm --filter @project/signal exec wrangler secret put REALTIME_APP_ID --env production
pnpm --filter @project/signal exec wrangler secret put REALTIME_APP_TOKEN --env production
pnpm --filter @project/signal exec wrangler secret put TURN_KEY_ID --env production
pnpm --filter @project/signal exec wrangler secret put TURN_KEY_TOKEN --env production
```

缺少 TURN 設定時，ICE API 只會回傳 STUN 伺服器；若兩端無法直連，就可能看不到影片。缺少 Realtime 設定時，轉發模式無法使用（伺服器回 `503 RELAY_UNAVAILABLE`），直連模式不受影響。[Cloudflare TURN 說明](https://developers.cloudflare.com/realtime/turn/)

## 7. 綁定自己的網址並驗收

1. 在 Cloudflare 後台開啟 **Workers & Pages**，在 **Overview** 選 **remote-sync-player-signal-production**。
2. 依序按 **Settings → Domains & Routes → Add → Custom Domain**。
3. 填入第 6 步的主機名稱（例如 `watch.example.com`，省略 `https://`），再按 **Add Custom Domain**。Cloudflare 會建立 DNS 記錄和 HTTPS 憑證。[Cloudflare 自訂網域操作步驟](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

> 📷 截圖：Cloudflare 後台 → Workers & Pages → remote-sync-player-signal-production → Settings → Domains & Routes → Add → Custom Domain（待補）

4. 在瀏覽器開啟 `https://你的網域/api/health`，應看到類似 `{"ok":true,"protocolVersion":1}` 的文字。
5. 開啟 `https://你的網域/`，應看到播放器首頁。有加入頁的版本也可以直接開啟一個實際邀請網址並重新整理，確認仍會載入網頁。請中國大陸的朋友在自己的網路上測試同一個正式網址。[Cloudflare SPA 路由說明](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)

> 📷 截圖：瀏覽器 → 自訂網域的 `/api/health` 顯示 `"ok":true`（待補）

## 8. 以後更新

取得新版專案後，保留第 6 步的正式網址設定，在專案根目錄執行下面兩行。看到 `Uploaded …` 後，再開一次正式站的 `/api/health` 確認。網域和機密設定在同一個 Worker 上，機密值有更新時才需要重新輸入。[Wrangler 指令](https://developers.cloudflare.com/workers/wrangler/commands/)

```sh
pnpm install --frozen-lockfile
pnpm deploy
```

如果只想檢查部署設定，可以先建置網頁，再直接執行 Wrangler 的預演。看到 `--dry-run: exiting now.` 代表檢查完成。請照抄第二行，因為 `pnpm deploy --dry-run` 會被 pnpm 的同名指令吃掉旗標。

```sh
pnpm --filter @project/web build
pnpm --filter @project/signal exec wrangler deploy --env production --dry-run
```

## 常見問題

| 遇到的情況                       | 可以怎麼做                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| 找不到 `node` 或 `pnpm`          | 安裝後關掉終端機重開，並重跑第 1 步的版本指令。                                         |
| pnpm 顯示 workspace 套件部署說明 | 確認你位於專案根目錄且使用指定的 pnpm 版本。也可用 `pnpm run deploy` 明確執行專案指令。 |
| Wrangler 顯示未登入或無權限      | 重跑第 4 步的登入與 `whoami`，比對終端機與網域後台是否使用同一個 Cloudflare 帳號。      |
| 自訂網址打不開或出現憑證錯誤     | 在 **Domains & Routes** 確認完整主機名稱，等 DNS 和憑證生效後再試。                     |
| `/api/health` 顯示首頁或 404     | 確認網域綁到第 7 步的正式 Worker，並用第 6 步指令重新部署。                             |
| 加入房間一直收到 `429`           | 同一 IP 每分鐘最多送出 10 次加入請求。等一分鐘再確認邀請碼並重試。                      |
| 轉發顯示 `503` 或直連收不到畫面  | 分別確認 Realtime 或 TURN 的兩項機密都已設定到 `production`，再重試。                   |

[自訂網域故障排除](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) · [Workers 限流說明](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
