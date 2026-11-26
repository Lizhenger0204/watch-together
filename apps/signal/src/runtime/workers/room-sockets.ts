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

export function onlineMembers(ctx: DurableObjectState, exclude?: WebSocket) {
  const ids = new Set<string>();
  for (const ws of ctx.getWebSockets()) {
    if (ws === exclude) continue;
    const memberId = attachmentOf(ws)?.memberId;
    if (memberId) ids.add(memberId);
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
  }: {
    now?: number;
    timeoutMs: number;
    exclude?: WebSocket;
    acceptedHeartbeatAt?: number;
  },
) {
  let earliest = acceptedHeartbeatAt;
  const expired: Array<{ ws: WebSocket; lastActivityAt: number }> = [];
  for (const ws of ctx.getWebSockets()) {
    if (ws === exclude) continue;
    const attachment = attachmentOf(ws);
    if (!attachment || attachment.memberId === null) continue;
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

/** 關閉連線。未驗證的連線一併清掉 auth 期限，之後不再為它排 alarm。 */
export function closeSocket(ws: WebSocket, code: number, reason: string) {
  try {
    const attachment = attachmentOf(ws);
    if (attachment?.memberId === null && attachment.authDeadline > 0) {
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
