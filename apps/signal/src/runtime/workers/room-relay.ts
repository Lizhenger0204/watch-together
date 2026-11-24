import type { Result } from "../../errors";
import type { RelayResource } from "../../relay";
import { createRealtime, type RelayEnv } from "../../relay/realtime";
import { findMember, type RoomState } from "../../room/room";

const RELAY_KEY = "relay";
type RelayState = {
  publicationId: string | null;
  resources: Record<string, RelayResource>;
  orphans: Record<string, RelayResource>;
};

export async function readRelay(
  reader: Pick<DurableObjectStorage, "get">,
): Promise<RelayState> {
  const stored = await reader.get<Partial<RelayState>>(RELAY_KEY);
  return {
    publicationId: stored?.publicationId ?? null,
    resources: stored?.resources ?? {},
    orphans: stored?.orphans ?? {},
  };
}

export function saveRelay(txn: DurableObjectTransaction, relay: RelayState) {
  return txn.put(RELAY_KEY, relay);
}

function retire(relay: RelayState, matches: (r: RelayResource) => boolean) {
  const retired = Object.values(relay.resources).filter(matches);
  for (const resource of retired) {
    relay.orphans[resource.id] = resource;
    delete relay.resources[resource.id];
    if (relay.publicationId === resource.id) relay.publicationId = null;
  }
  return retired;
}

export async function retireRoomResources(
  txn: DurableObjectTransaction,
  before: RoomState,
  next: RoomState,
  departed?: string,
) {
  const removed = new Set(
    before.members
      .filter((m) => !findMember(next, m.memberId))
      .map((m) => m.memberId),
  );
  if (departed) removed.add(departed);
  const modeChanged = before.mode !== next.mode;
  if (!modeChanged && !removed.size) return [];
  const relay = await readRelay(txn);
  const retired = retire(
    relay,
    (r) => modeChanged || (r.publicationId !== null && removed.has(r.ownerId)),
  );
  if (retired.length) await saveRelay(txn, relay);
  return retired;
}

export async function registerResource(
  txn: DurableObjectTransaction,
  room: RoomState | undefined,
  resource: RelayResource,
): Promise<Result<RelayResource[]>> {
  if (!room) return { ok: false, code: "ROOM_NOT_FOUND" };
  const owner = findMember(room, resource.ownerId);
  if (!owner || (resource.publicationId === null && owner.role !== "host")) {
    return { ok: false, code: "FORBIDDEN" };
  }
  if (
    room.mode !== "relay" ||
    (owner.relayGeneration ?? 0) !== (resource.ownerGeneration ?? 0)
  )
    return { ok: false, code: "STREAM_NOT_LIVE" };
  const relay = await readRelay(txn);
  let retired: RelayResource[] = [];
  if (resource.publicationId === null) {
    // 舊版可能留下多個發布。一次撤下所有舊發布與綁定它們的訂閱。
    retired = retire(
      relay,
      (r) => r.id !== resource.id && r.publicationId !== resource.id,
    );
    relay.publicationId = resource.id;
  } else if (
    !room.stream.live ||
    relay.publicationId !== resource.publicationId
  ) {
    return { ok: false, code: "STREAM_NOT_LIVE" };
  }
  relay.resources[resource.id] = resource;
  await saveRelay(txn, relay);
  return { ok: true, value: retired };
}

export function removeResource(storage: DurableObjectStorage, id: string) {
  return storage.transaction(async (txn) => {
    const relay = await readRelay(txn);
    if (
      !Object.hasOwn(relay.resources, id) &&
      !Object.hasOwn(relay.orphans, id)
    )
      return;
    delete relay.resources[id];
    delete relay.orphans[id];
    if (relay.publicationId === id) relay.publicationId = null;
    await saveRelay(txn, relay);
  });
}

export async function closeResources(
  storage: DurableObjectStorage,
  env: RelayEnv,
  targets: RelayResource[],
) {
  if (!targets.length) return 0;
  let realtime: ReturnType<typeof createRealtime>;
  try {
    realtime = createRealtime(env);
  } catch {
    return targets.length;
  }
  let left = 0;
  for (const resource of targets) {
    try {
      await realtime.closeTracks(
        resource.sessionId,
        resource.tracks.map(({ mid }) => mid),
      );
    } catch {
      left += 1;
      continue;
    }
    await removeResource(storage, resource.id);
  }
  return left;
}
