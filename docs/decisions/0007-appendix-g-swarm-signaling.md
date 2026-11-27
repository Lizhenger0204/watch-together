# ADR 0007 附錄 G：收看者之間的信令與 IP 規則草稿（T-140）

> **草稿（T-140）**：ADR 0007 採用前沒有效力，現行 `protocol.md`、`AGENTS.md` 的規則不變。採用後由 T-146 先改 `protocol.md` 與 `packages/shared`，再改伺服器；`AGENTS.md` 的對應句子由協調者更新。

## §1 規則改變

現行規則：收看者的 `signal` 只能送給房主，伺服器擋下送給其他收看者的。種子式散布需要收看者之間建立連線，改為：**只有房主登記、伺服器確認有效的配對**，才轉送收看者之間的信令。收看者之間的信令用**獨立的訊息** `peer:signal`，不沿用 `signal`：舊版收看端的 `signal` schema 會略過新欄位，把散布的 offer 當成房主的 offer 交給影音連線，可能把房主的連線關掉。

## §2 配對紀錄

- **連線 ID**：伺服器在每條 WebSocket 完成 `auth` 時配發隨機的 `connId`（128 位元），和 `memberId` 一起寫進該 WebSocket 的休眠 attachment。每條已驗證的連線一個，不重複使用。`connId` 不是憑證：伺服器在給房主的成員上線資訊（`room:snapshot`、成員狀態更新）裡附上每位收看者目前的 `connId`，房主下配對指令時要帶上。
- **能力宣告**：新版收看端在 `auth` 成功後送 `swarm:hello { version: 1 }`，伺服器記在該連線的 attachment；沒宣告的連線（舊版）不會被配對，也永遠收不到 `peer:signal`。
- RoomDO 的房間狀態記 `swarm = { on, liveId, pairs: [{ pairId, a, b, aConn, bConn }] }`：`liveId` 是**直播世代**，只在「未開播 → 開播」的轉換被接受時配發新的（直播中更新片名等 `live: true` 的訊息**不**換世代），並在回給房主的 `ack` 與 `stream:status` 裡告知；停播、房主重新連線讓它失效。**每次世代改變，在同一筆交易撤銷所有舊配對**（每筆配對也記下它的 `liveId`）。`aConn`／`bConn` 是登記當下雙方的 `connId`，`pairId` 在房內遞增不重複。全部在既有的 `changes` 佇列內讀寫，與席位同一筆交易提交。
- **配對只在「P2P 模式、正在直播」時有效**；`swarm.on` 也只在這段期間可以為真。

## §3 處理順序

1. `swarm:mode { on }`、`swarm:pair { a, aConn, b, bConn, liveId }`、`swarm:unpair { a, b, pairId }` 只有房主能送（伺服器檢查角色）。
2. `swarm:pair` 在佇列內檢查：模式已開、P2P 且正在直播、`liveId` 等於目前的直播世代、`aConn`／`bConn` 等於兩人**此刻**的連線且都宣告過 `swarm:hello`、兩人都是本房在線且已 `auth` 的收看者。任一不符就回 `ack { ok: false }`、不建立配對——延遲到達的舊指令（同一條連線停播再開後、對方重連後）因此不會建立房主沒有指定的配對。**先提交**，提交後回房主 `ack { ok: true, pairId }`，再送 `swarm:paired { peer, pairId }` 給雙方。房主收到 `ack` 後，也在自己與雙方的 `pt-ctl` 送 `pairHint { peer, pairId }`（這條通道與 WebSocket 無關）；收看端收到 `pairHint` 卻沒收過對應的 `swarm:paired`，**立刻**送 `swarm:check`（第 7 點）。所以發 offer 方或應答方任一方漏收，都能在幾百毫秒內補回。房主 15 秒內沒收到雙方的 `peerOpen` 才 `swarm:unpair` 清掉這一對。T-146／T-147 分別驗收「發 offer 方漏收」與「應答方漏收」。
3. **送到已核對的實體連線**：`swarm:paired`、`peer:signal`、`swarm:unpaired`、`swarm:valid` 都只送到配對紀錄裡那條 `connId` 的 WebSocket，不是「這位成員目前的任一連線」。
4. 收看者 X → Y 的 `peer:signal { to, pairId, data }`：在佇列內、**實際送出前**確認：配對存在且 `pairId` 相符；X 這條連線的 `connId` 等於登記的那一個；Y 的登記連線仍在線；模式仍開；P2P、正在直播、直播世代沒變。轉送時帶 `pairId`；收看端只接受與目前配對相符的 `pairId`，舊配對的 SDP／candidate 直接丟掉。
5. **誰發 offer**：`memberId` 較小的一方；3 秒、8 秒還沒收到 answer 就重送同一份 offer（對方可能因為還沒收到 `swarm:paired` 而先丟掉）。雙方的 `sw-ctl`、`sw-data` 都開啟、而且各自確認選中的 candidate pair 不是 relay（附錄 H）後，各自在 `pt-ctl` 向房主送 `peerOpen { peer, pairId }`，關閉時送 `peerClosed`；房主只把雙方都回報 `peerOpen` 的配對當作可指派的鄰居（附錄 D §4）。
6. **撤銷**，與觸發的變更**同一筆交易**：踢出、離開、**任何原因的斷線**（正常關閉、WebSocket 錯誤、心跳逾時 `4410`、新連線取代 `4000`）、房主重新連線（撤銷全部）、停播、關閉模式、切到轉發、房主 `swarm:unpair`（`pairId` 必須等於目前那一對，否則忽略，避免延遲的撤銷取消新配對）。提交後送 `swarm:unpaired { peer, pairId }` 給雙方仍在線的登記連線，收到的一方關閉對應的 PeerConnection。
7. **通知遺失時的自我核對**：收看端收到 `pairId` 不認得的 `peer:signal` 時**立刻**送 `swarm:check`（這則先暫存 2 秒，核對通過就處理），另外每 30 秒、以及 `pt-ctl` 或 WebSocket 恢復時也送；房主的 15 秒清理期限因此晚於補回。伺服器回 `swarm:valid { pairs: [{ peer, pairId }] }`——**這條連線此刻獲授權的全部配對**，判斷條件與第 4 點轉送 `peer:signal` 完全相同（不只收看端知道的），所以漏收 `swarm:paired` 的一方也能補回。收看端關閉不在清單裡的 PeerConnection，清單裡還沒建立的照第 5 點建立。收看端自己的 WebSocket 一重連（新的 `connId`），就關閉所有收看者之間的連線，因為舊配對都已撤銷。
8. **Durable Object 喚醒**：配對在 storage 裡，但喚醒後要用休眠 WebSocket 的 attachment 確認 `aConn`／`bConn` 仍是活著的連線；任一方對不上，該配對一律撤銷。
9. **統一的拒絕**：`peer:signal` 凡是授權不通過（對方不存在、不在線、沒配對、`pairId` 過期、`connId` 不符、沒宣告 `swarm:hello`、模式已關、不在直播）一律回 `error { code: 'FORBIDDEN' }`、同一句訊息，不透露原因。只有與對象無關的格式錯誤回 `BAD_REQUEST`。現行「房主 ↔ 收看者」的回應不變。

## §4 IP 規則（使用者決定，2026-11-27）

**同房的人可以互相看到 IP；沒有邀請碼、沒進房的人絕不能拿到任何人的 IP。**

**可驗收的承諾**（主文、附錄與提示都用這一句）：**本產品只把成員的 IP、SDP 與 candidate 交給已完成驗證、而且當下對這個房間與目標連線有授權的房主或收看者**（收看者靠邀請碼進房，房主靠建房取得資格）。 STUN 伺服器（現行設定的第三方基礎設施）為了回報公網位址，本來就會看到連線的來源 IP；TURN 伺服器也看得到經它中繼的連線。這和現在的直播相同，不屬於「其他人」，也不在承諾範圍內。

- **IP 在什麼時候被看到**：ICE 要在連線建立**之前**交換位址，所以只要伺服器把你的 SDP／candidate 轉給某位成員，他就可能看到你的 IP，**即使之後直連沒有成功**。授權的判斷點因此是「伺服器轉送信令的那一刻」（§3 第 4 步）。會收到你信令的只有：房主，以及房主登記、與你配對的收看者。
- **承諾涵蓋**：本產品的信令、REST 端點、錯誤訊息、關閉原因與 log。撤銷只能阻止之後的轉送；撤銷前已轉出的位址無法收回；撤銷提交前已交給 WebSocket 的訊息仍可能晚一點送達。
- **驗證方式**：P2P 信令走 WebSocket，連線要先完成 `auth`（收看者用 `memberToken`、房主用 `hostToken`）。第三層 WHIP／WHEP 的 SDP 回應（對象是 Cloudflare 的伺服器，不是其他成員）沿用現行 REST 的 Bearer 驗證，不變。
- 收看者之間只用 STUN（沿用現行設定，不只 Google），**不給 TURN**（TURN 流量要付費）；直連不上就這一對不配對。Chrome 的 host candidate 是 mDNS，公網 IP 會出現在 srflx candidate。

| # | 檢查點 | 驗證 |
| --- | --- | --- |
| 1 | 每條會帶出 SDP／candidate 的路徑都有自己的授權條件，未授權者收不到：**既有 `signal`**（房主 ↔ 收看者，規則不變）——送方與收方都是本房、已完成 `auth`（房主 `hostToken`、收看者 `memberToken`）、目前在線的成員，收看者只能送給房主，送到收方此刻的那條連線；**`peer:signal`**——§3 第 4 點；**WHIP／WHEP**（第三層轉發）——REST Bearer（房主的 WHIP 用 `hostToken`、收看者的 WHEP 用 `memberToken`）且房間相符，回應裡只有 Cloudflare 伺服器的位址 | 伺服器單元測試：每條路徑各測「未 `auth`／無效 token／別房／目標不在線（或非配對對象）」 |
| 2 | 公開或未驗證的端點（REST 房間資訊、加入前的查詢）、錯誤訊息、關閉原因、log 都不帶 IP、SDP 或 candidate；伺服器不記錄 `signal.data` | 測試檢查 JSON、獨立的 SDP 文字（`a=candidate`、`c=IN IP4`／`IP6`）、IPv4 與 IPv6 位址樣式、關閉原因與 log 內容，不只看欄位名稱 |
| 3 | 被踢出、離開或斷線：從撤銷提交起，兩個方向都不再轉送；其他人關閉與他的連線。重新產生邀請碼後舊碼不能進房 | 伺服器測試；E2E #5 |
| 4 | **第一道防線是邀請碼**：沿用防暴力猜測（限流、錯誤一律同一種訊息、可重新產生，room-and-invite.md） | 既有測試 |
| 5 | **E2E**（T-146）：先驗證 (a) 合法配對的兩位收看者**收得到**彼此的 SDP 與 candidate。之後每個案例都驗證兩件事：未授權的 SDP／candidate 收不到，以及**屏障之後**送出的標記訊息到不了另一端（兩個方向）。屏障依撤銷方式而定：WebSocket 指令——`swarm:unpair`、`room:kick`、`swarm:mode { on: false }`（關閉散布）、停播、切到轉發——以提交後的 `ack` 為準；REST 離開以 `204` 為準；斷線（正常關閉、錯誤、心跳逾時）、舊連線被取代、房主重新連線等競態無法從瀏覽器得知提交時點，改用知道提交時點的伺服器測試，每一種各一個案例。案例：(b) 未配對、(c) 只連 WebSocket 尚未 `auth`、(d) 別房或無效的 token、(e) 舊連線（被新分頁取代）、(f) 舊 `pairId`（撤銷後、或撤銷再配對後）、(g) 延遲到達的舊 `swarm:pair`（停播重開後）、(g2) 舊版收看端（沒宣告 `swarm:hello`）不被配對、收不到 `peer:signal`，新舊版同房時照常收看、(h) 離開、(i) 被踢出、(j) 舊邀請碼 | T-146 |

## §5 提示文字

- **房主開啟時**：「開啟『收看者互相轉送』後，收看者會把收到的影片片段轉送給同房間的其他人，減輕你的上傳負擔。被安排互相連線的成員，在連線時就會看到對方的網路位址（IP），即使最後沒連上；本服務只會把你的 IP 交給這個房間裡、正和你建立連線的已驗證成員。每個片段都會用你這邊發出的校驗碼檢查，被改過的資料會被丟掉。」
- **收看者進房（已開啟時）**：「這個房間開啟了『互相轉送』：你會和同房間的幾位已驗證成員直接連線，連線時彼此會看到 IP（不會給房間以外的人）；你也可能把已收到的片段轉送給他們。用手機網路或上傳較慢時，可以關閉『幫忙轉送』，只下載。」

## §6 協議變動（給 T-146）

- 新增 `swarm:mode { on }`、`swarm:pair { a, aConn, b, bConn, liveId }`、`swarm:unpair { a, b, pairId }`（房主 → 伺服器）；`swarm:hello { version }`、`swarm:check`、`peer:signal { to, pairId, data }`（收看者 → 伺服器）；`swarm:paired { peer, pairId }`、`swarm:unpaired { peer, pairId }`、`swarm:valid { pairs }`、`peer:signal { from, pairId, data }`（伺服器 → 收看者）。給房主的成員資訊加 `connId`；開播的 `ack` 與 `stream:status` 加 `liveId`。
- 既有 `signal` 不變（收看者仍只能送給房主）；收看者之間只用 `peer:signal`。
- WebSocket 的休眠 attachment 加 `connId`。
