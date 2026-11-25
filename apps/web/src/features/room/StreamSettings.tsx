import type { Mode, RoomInfo } from "@project/shared";
import { Notice, Segmented } from "../../components/ui";
import { formatMbps, uploadHint } from "./room-state";

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: "p2p", label: "P2P 直連" },
  { value: "relay", label: "轉發" },
];

export function StreamSettings({
  room,
  viewers,
  bitrate,
  busy = false,
  onModeChange,
  onLockedChange,
}: {
  room: RoomInfo;
  viewers: number;
  /** 每位收看者的實際位元率（bps，已依片源解析「原片」）。 */
  bitrate: number;
  /** 開播、停播、切換傳送方式或重新連線同步中：暫時不能改傳送方式。 */
  busy?: boolean;
  onModeChange: (mode: Mode) => void;
  onLockedChange: (locked: boolean) => void;
}) {
  const upload = uploadHint(room.mode, bitrate, viewers);
  return (
    <section className="px-4 py-3.5">
      <h3 className="mb-3 text-xs font-semibold text-zinc-500">播放設定</h3>
      <div className="grid gap-4">
        <Segmented
          label="傳送方式"
          value={room.mode}
          options={MODE_OPTIONS}
          disabled={busy}
          onChange={(mode) => {
            if (mode !== room.mode) onModeChange(mode);
          }}
        />
        {upload && (
          <Notice tone={upload.warn ? "warning" : "info"}>
            {viewers} 位收看者，預估上傳 {formatMbps(upload.total)}。
            {upload.warn && "超過 60 Mbps，建議調低位元率或改用「轉發」模式。"}
          </Notice>
        )}
        <label className="flex cursor-pointer items-center justify-between gap-3 border-t border-zinc-100 pt-3 text-sm text-zinc-800">
          <span>
            鎖定房間
            <span className="block text-xs text-zinc-500">
              鎖定後新成員無法加入
            </span>
          </span>
          <input
            type="checkbox"
            className="size-4 accent-[#0072b2]"
            checked={room.locked}
            onChange={(event) => onLockedChange(event.currentTarget.checked)}
          />
        </label>
      </div>
    </section>
  );
}
