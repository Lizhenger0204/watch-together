import { useEffect, useState } from "react";
import { getHealth } from "./lib/api";

export function App() {
  const [status, setStatus] = useState("正在檢查服務狀態…");

  useEffect(() => {
    const controller = new AbortController();

    void getHealth(controller.signal).then(
      ({ protocolVersion }) =>
        setStatus(`服務正常（協定版本 ${protocolVersion}）`),
      () => {
        if (!controller.signal.aborted) {
          setStatus("無法取得服務狀態");
        }
      },
    );

    return () => controller.abort();
  }, []);

  return (
    <main className="p-4">
      <h1 className="text-xl font-bold">遠端同步播放器</h1>
      <p role="status">{status}</p>
    </main>
  );
}
