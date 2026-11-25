import type { Member, MemberStatus } from "@project/shared";

const STATE_LABEL: Record<MemberStatus["state"], string> = {
  waiting: "等待中",
  connecting: "連線中",
  playing: "觀看中",
  buffering: "緩衝中",
  failed: "連線失敗",
};

function quality(status: MemberStatus | undefined) {
  if (!status) return null;
  const parts = [STATE_LABEL[status.state]];
  if (status.bitrateKbps !== undefined)
    parts.push(`${(status.bitrateKbps / 1000).toFixed(1)} Mbps`);
  if (status.rttMs !== undefined)
    parts.push(`延遲 ${Math.round(status.rttMs)} ms`);
  if (status.packetLoss !== undefined && status.packetLoss > 0.01) {
    parts.push(`掉包 ${(status.packetLoss * 100).toFixed(0)}%`);
  }
  return parts.join("・");
}

export function MemberList({
  members,
  youId,
  isHost,
  memberStatus,
  onKick,
}: {
  members: Member[];
  youId: string;
  isHost: boolean;
  memberStatus: Record<string, MemberStatus>;
  onKick: (memberId: string) => void;
}) {
  const online = members.filter((m) => m.online).length;
  return (
    <section className="px-4 py-3.5">
      <h3 className="mb-2 text-xs font-semibold text-zinc-500">
        成員（{online} 人在線）
      </h3>
      <ul className="divide-y divide-zinc-100 lg:max-h-40 lg:overflow-y-auto">
        {members.map((member) => {
          const status =
            member.role === "member" && member.online
              ? quality(memberStatus[member.memberId])
              : null;
          return (
            <li
              key={member.memberId}
              className="flex items-center gap-2.5 py-2"
            >
              <span
                aria-label={member.online ? "在線" : "離線"}
                className={`size-2 shrink-0 rounded-full ${member.online ? "bg-emerald-600" : "bg-zinc-300"}`}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-zinc-900">
                  {member.nickname}
                  {member.role === "host" && (
                    <span className="ml-1.5 text-xs font-medium text-[#0072b2]">
                      房主
                    </span>
                  )}
                  {member.memberId === youId && (
                    <span className="ml-1 text-xs text-zinc-500">（你）</span>
                  )}
                </p>
                {isHost && status && (
                  <p className="text-xs text-zinc-500">{status}</p>
                )}
              </div>
              {isHost && member.role === "member" && (
                <button
                  type="button"
                  className="shrink-0 rounded px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-[#0072b2] focus-visible:outline-none"
                  onClick={() => {
                    if (
                      window.confirm(
                        `確定要請「${member.nickname}」離開房間嗎？`,
                      )
                    )
                      onKick(member.memberId);
                  }}
                >
                  踢出
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
