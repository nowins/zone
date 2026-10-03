import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../../../components/Button";
export function TransferActions() {
 const [busy,setBusy]=useState<string|null>(null);const [error,setError]=useState<string|null>(null);const [message,setMessage]=useState<string|null>(null);
 async function run(kind:"import"|"export") {setBusy(kind);setError(null);setMessage(null);try {
 if(kind==="import"){const report=await invoke<{imported:number;skipped:number;failures:string[]}|null>("podcast_import_opml");if(report){setMessage(`已导入 ${report.imported} 个节目，已有 ${report.skipped} 个，失败 ${report.failures.length} 个`);if(report.failures.length)setError(report.failures.slice(0,3).join("；"));}}
 else if(await invoke<boolean>("podcast_export_opml"))setMessage("订阅已导出");
 }catch(reason){setError(String(reason));}finally{setBusy(null);}}
 return <div className="podcast-transfer-actions"><div><Button variant="ghost" disabled={busy!==null} busy={busy==="import"} onClick={()=>void run("import")}>导入订阅</Button><Button variant="ghost" disabled={busy!==null} busy={busy==="export"} onClick={()=>void run("export")}>导出订阅</Button></div>{message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}</div>;
}
