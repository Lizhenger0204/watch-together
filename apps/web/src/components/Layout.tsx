import { Tv } from "lucide-react";
import type { ReactNode } from "react";
import { navigate } from "../lib/router";

export function Layout({
  children,
  wide = false,
  flush = false,
  headerRight,
}: {
  children: ReactNode;
  wide?: boolean;
  /** 房間頁使用：移除外層卡片留白，讓影片與右側欄貼齊分割線展開。 */
  flush?: boolean;
  headerRight?: ReactNode;
}) {
  const container = flush
    ? "mx-auto w-full max-w-[1440px]"
    : `mx-auto w-full px-4 ${wide ? "max-w-6xl" : "max-w-3xl"}`;

  return (
    <div className="min-h-dvh bg-white text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div
          className={`${flush ? "mx-auto flex h-12 w-full max-w-[1440px] items-center justify-between gap-3 px-4" : `${container} flex h-12 items-center justify-between gap-3`}`}
        >
          <a
            href="/"
            onClick={(event) => {
              event.preventDefault();
              navigate("/");
            }}
            className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-900 hover:text-[#0095d9]"
          >
            <Tv className="size-4 text-[#0095d9]" strokeWidth={1.75} />
            遠端同步播放器
          </a>
          {headerRight && (
            <div className="flex items-center gap-2">{headerRight}</div>
          )}
        </div>
      </header>
      <main className={flush ? container : `${container} py-6 sm:py-10`}>
        {children}
      </main>
    </div>
  );
}
