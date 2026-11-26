import { CLOSE } from "../../signaling/process";

export type Attachment = {
  memberId: string | null;
  authDeadline: number;
  lastActivityAt?: number;
};

export function attachmentOf(ws: WebSocket): Attachment | null {
  return (ws.deserializeAttachment() as Attachment | null) ?? null;
}

export function socketsOf(ctx: DurableObjectState, memberId: string) {
  return ctx
    .getWebSockets()
    .filter((ws) => attachmentOf(ws)?.memberId === memberId);
}

const WS_OPEN = 1;

function isOpenSocket(ws: WebSocket) {
  return ws.readyState === undefined || ws.readyState === WS_OPEN;
}

export function onlineMembers(
  ctx: DurableObjectState,
  exclude?: WebSocket,
  validMemberIds?: ReadonlySet<string>,
) {
  const ids = new Set<string>();
  for (const ws of ctx.getWebSockets()) {
    if (ws === exclude || !isOpenSocket(ws)) continue;
    const memberId = attachmentOf(ws)?.memberId;
    if (memberId && (!validMemberIds || validMemberIds.has(memberId))) {
      ids.add(memberId);
    }
  }
  return ids;
}

export function acceptMember(
  ctx: DurableObjectState,
  ws: WebSocket,
  memberId: string,
  now = Date.now(),
) {
  for (const other of socketsOf(ctx, memberId)) {
    other.serializeAttachment({
      memberId: null,
      authDeadline: 0,
    } satisfies Attachment);
    closeSocket(other, CLOSE.REPLACED, "replaced");
  }
  ws.serializeAttachment({
    memberId,
    authDeadline: 0,
    lastActivityAt: now,
  } satisfies Attachment);
}

/** 記錄已驗證連線的最後活動時間，不碰 DO storage。 */
export function touchSocket(
  ws: WebSocket,
  attachment: Attachment,
  now: number,
) {
  if (attachment.memberId === null) return;
  ws.serializeAttachment({
    ...attachment,
    lastActivityAt: now,
  } satisfies Attachment);
}

/** 依已驗證連線的最後活動時間計算下一次心跳檢查期限與已逾時連線。 */
export function heartbeatTimeouts(
  ctx: DurableObjectState,
  {
    now,
    timeoutMs,
    exclude,
    acceptedHeartbeatAt = Infinity,
    validMemberIds,
  }: {
    now?: number;
    timeoutMs: number;
    exclude?: WebSocket;
    acceptedHeartbeatAt?: number;
    validMemberIds?: ReadonlySet<string>;
  },
) {
  let earliest = acceptedHeartbeatAt;
  const expired: Array<{ ws: WebSocket; lastActivityAt: number }> = [];
  for (const ws of ctx.getWebSockets()) {
    if (ws === exclude || !isOpenSocket(ws)) continue;
    const attachment = attachmentOf(ws);
    if (!attachment || attachment.memberId === null) continue;
    if (validMemberIds && !validMemberIds.has(attachment.memberId)) continue;
    let lastActivityAt = attachment.lastActivityAt;
    if (lastActivityAt === undefined) {
      if (now === undefined) continue;
      lastActivityAt = now;
      ws.serializeAttachment({
        ...attachment,
        lastActivityAt,
      } satisfies Attachment);
    }
    if (now !== undefined && now - lastActivityAt >= timeoutMs) {
      expired.push({ ws, lastActivityAt });
    } else {
      earliest = Math.min(earliest, lastActivityAt + timeoutMs);
    }
  }
  return { alarm: earliest, expired };
}

/** 依提交後的連線集合排 alarm；成功提交後才接線、接手或關閉逾時連線。 */
export function authTimeouts(
  ctx: DurableObjectState,
  {
    accepted,
    openingDeadline = Infinity,
    now,
  }: {
    accepted?: WebSocket;
    openingDeadline?: number;
    now?: number;
  } = {},
) {
  let earliest = openingDeadline;
  const expired: WebSocket[] = [];
  for (const ws of ctx.getWebSockets()) {
    if (ws === accepted) continue;
    const attachment = attachmentOf(ws);
    if (attachment?.memberId !== null || attachment.authDeadline <= 0) continue;
    if (now !== undefined && now > attachment.authDeadline) expired.push(ws);
    else earliest = Math.min(earliest, attachment.authDeadline);
  }
  return { alarm: earliest + 100, expired };
}

/** 關閉連線。先清掉成員與 auth 期限附件，避免 CLOSING 連線被當成在線或重複排 alarm。 */
export function closeSocket(ws: WebSocket, code: number, reason: string) {
  try {
    const attachment = attachmentOf(ws);
    if (
      attachment &&
      (attachment.memberId !== null || attachment.authDeadline > 0)
    ) {
      ws.serializeAttachment({
        memberId: null,
        authDeadline: 0,
      } satisfies Attachment);
    }
  } catch {
    // 連線已不可用，附件寫不進去也無妨
  }
  try {
    ws.close(code, reason);
  } catch {
    // 已經關閉
  }
}
