import { Component, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "./Button";
import { APP_VERSION } from "../app/releaseInfo";
import { exportDiagnostics, recordDiagnostic } from "../utils/diagnostics";

export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; notice: string }> {
  state = { error: null as Error | null, notice: "" };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    recordDiagnostic({ domain: "library", event: "ui_fatal_error", outcome: "error" });
    if (import.meta.env.DEV) console.error(error);
  }
  async saveDiagnostics() {
    try {
      const saved = await invoke<boolean>("export_diagnostics", { content: exportDiagnostics() });
      this.setState({ notice: saved ? "诊断记录已导出" : "" });
    } catch { this.setState({ notice: "导出失败，请重试" }); }
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <main className="fatal-screen" role="alert">
      <h1>zone</h1><p>界面遇到问题，重新加载后可继续使用。</p><span>Zone {APP_VERSION}</span>
      <div className="fatal-actions"><Button onClick={() => window.location.reload()}>重新加载</Button>
        <Button variant="ghost" onClick={() => void this.saveDiagnostics()}>导出诊断记录</Button></div>
      {this.state.notice && <p role="status">{this.state.notice}</p>}
    </main>;
  }
}
