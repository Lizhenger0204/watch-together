import type { ReactNode } from "react";
import { navigate } from "../lib/router";

export function Layout({
  children,
  wide = false,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100">
      <header className="border-b border-white/5">
        <div
          className={`mx-auto flex h-14 items-center px-4 ${wide ? "max-w-6xl" : "max-w-3xl"}`}
        >
          <a
            href="/"
            onClick={(event) => {
              event.preventDefault();
              navigate("/");
            }}
            className="flex items-center gap-2 font-semibold text-white"
          >
            <span className="grid size-7 place-items-center rounded-lg bg-violet-600 text-sm">
              遠
            </span>
            遠端同步播放器
          </a>
        </div>
      </header>
      <main
        className={`mx-auto px-4 py-6 sm:py-10 ${wide ? "max-w-6xl" : "max-w-3xl"}`}
      >
        {children}
      </main>
    </div>
  );
}
