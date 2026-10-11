import { useState, type CSSProperties } from "react";
import { AppHeader } from "./AppHeader";
import { Button } from "./Button";
import { MetroLoader } from "./MetroLoader";
import { Titlebar } from "./Titlebar";
import { readPlaybackBehaviorSettings } from "../app/playbackSettings";
import { MOTION_DURATIONS } from "../motion/tokens";

export function StartupView({ failed = false, onRetry }: { failed?: boolean; onRetry?: () => void }) {
  // Keep the reveal on the document's clock across the lazy shell hand-off.
  const [revealDelay] = useState(() => Math.max(-MOTION_DURATIONS.micro, MOTION_DURATIONS.page - performance.now()));
  return (
    <section className="startup-view" role={failed ? "alert" : "status"} aria-label={failed ? "资料库恢复失败" : "正在打开资料库"}>
      {failed ? <>
        <p>资料库恢复失败，原有数据已保留</p>
        <Button onClick={onRetry}>重试</Button>
      </> : <div className="startup-loading" style={{ "--startup-loading-delay": `${revealDelay}ms` } as CSSProperties}>
        <MetroLoader large />
        <p>正在打开资料库</p>
      </div>}
    </section>
  );
}

export function StartupShell() {
  return <div className="shell">
    <Titlebar isSettings={false} showSettings={false} onOpenSettings={() => {}}
      closeToTray={readPlaybackBehaviorSettings().closeToTray} />
    <main className="workspace" aria-busy="true">
      <AppHeader page="quickplay" disabled onNavigate={() => {}} />
      <StartupView />
    </main>
  </div>;
}
