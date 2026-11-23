import {
  QUALITY_PRESETS,
  type Mode,
  type Quality,
  type RoomInfo,
} from "@project/shared";
import { Card, Notice, Segmented } from "../../components/ui";
import { estimateP2pUpload, formatMbps, type RoomUpdate } from "./room-state";

const MODE_OPTIONS: { value: Mode; label: string; description: string }[] = [
  {
    value: "p2p",
    label: "P2P 直連",
    description:
      "影片從你的電腦直接送到每位朋友。人越多，你的上傳頻寬用得越多。",
  },
  {
    value: "relay",
    label: "轉發",
    description:
      "影片經 Cloudflare 轉發，你只需要上傳一份。適合人多或上傳頻寬不夠時。",
  },
];

const QUALITY_OPTIONS = (Object.keys(QUALITY_PRESETS) as Quality[]).map(
  (value) => ({
    value,
    label: QUALITY_PRESETS[value].label,
    description: `${QUALITY_PRESETS[value].targetHeight}p・每人 ${formatMbps(QUALITY_PRESETS[value].maxBitrate)}`,
  }),
);

export function StreamSettings({
  room,
  viewers,
  onChange,
}: {
  room: RoomInfo;
  viewers: number;
  onChange: (patch: RoomUpdate) => void;
}) {
  const upload = estimateP2pUpload(room.quality, viewers);
  return (
    <Card title="播放設定">
      <div className="grid gap-5">
        <Segmented
          label="傳送方式"
          value={room.mode}
          options={MODE_OPTIONS}
          onChange={(mode) => onChange({ mode })}
        />
        <Segmented
          label="畫質"
          value={room.quality}
          options={QUALITY_OPTIONS}
          onChange={(quality) => onChange({ quality })}
        />
        {room.mode === "p2p" && viewers > 0 && (
          <Notice tone={upload.warn ? "warning" : "info"}>
            {viewers} 位收看者，預估你要上傳 {formatMbps(upload.total)}。
            {upload.warn &&
              "超過 60 Mbps，建議改用「流暢」畫質或「轉發」模式。"}
          </Notice>
        )}
        <label className="flex items-center justify-between gap-3 text-sm text-zinc-300">
          <span>
            鎖定房間
            <span className="block text-xs text-zinc-500">
              鎖定後新的人無法加入，已在房內的人不受影響。
            </span>
          </span>
          <input
            type="checkbox"
            className="size-5 accent-violet-500"
            checked={room.locked}
            onChange={(event) =>
              onChange({ locked: event.currentTarget.checked })
            }
          />
        </label>
      </div>
    </Card>
  );
}
