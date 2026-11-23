import { SourceDemo } from "./features/source/SourceDemo";
import { HomePage, JoinPage, NotFoundPage } from "./pages/HomePage";
import { RoomPage } from "./pages/RoomPage";
import { parseRoute, usePathname } from "./lib/router";

export function App() {
  const pathname = usePathname();

  // T-106 的暫時展示入口，T-111 把 E2E 改到正式頁面後移除。
  if (new URLSearchParams(window.location.search).get("demo") === "source") {
    return <SourceDemo />;
  }

  const route = parseRoute(pathname);
  switch (route.page) {
    case "home":
      return <HomePage />;
    case "join":
      return <JoinPage inviteCode={route.inviteCode} />;
    case "room":
      return <RoomPage key={route.roomId} roomId={route.roomId} />;
    default:
      return <NotFoundPage />;
  }
}
