import type { Member, MemberStatus } from "@project/shared";
import { Button, Card } from "../../components/ui";

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
    <Card title={`成員（${online} 人在線）`}>
      <ul className="grid gap-2">
        {members.map((member) => {
          const status =
            member.role === "member" && member.online
              ? quality(memberStatus[member.memberId])
              : null;
          return (
            <li
              key={member.memberId}
              className="flex items-center gap-3 rounded-lg bg-white/5 px-3 py-2"
            >
              <span
                aria-label={member.online ? "在線" : "離線"}
                className={`size-2.5 shrink-0 rounded-full ${member.online ? "bg-emerald-400" : "bg-zinc-600"}`}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-white">
                  {member.nickname}
                  {member.role === "host" && (
                    <span className="ml-2 text-xs text-violet-300">房主</span>
                  )}
                  {member.memberId === youId && (
                    <span className="ml-2 text-xs text-zinc-500">（你）</span>
                  )}
                </p>
                {isHost && status && (
                  <p className="text-xs text-zinc-400">{status}</p>
                )}
              </div>
              {isHost && member.role === "member" && (
                <Button
                  variant="ghost"
                  className="min-h-8 px-2 text-xs"
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
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
