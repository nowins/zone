# Zone

Zone 是受 Microsoft Zune 4.8 启发的 Windows 本地音乐播放器，使用 Tauri 2、React 18 和 TypeScript。提供本地曲库、quickplay 磁贴、同步歌词、封面拼贴和播客收听。

## 开发与验证

需要 Windows Rust/MSVC 工具链、WebView2 与 Node.js。推荐 Node.js 24.15 以上的 24 LTS；其他受支持版本见 `package.json` 的 `engines`。

```powershell
npm ci
npm run build
npm test
cd src-tauri
cargo check
cargo test --lib
```

交互开发使用 `npm run tauri:dev`。纯浏览器开发不能完整验证原生协议与音频可视化。真实网络和音频 fixture 测试默认忽略，运行方式见各 Rust 测试源码。

## 安装与发布

当前版本为 0.1.1，首发准备使用 Microsoft Store 的 Win32 NSIS 安装包。版本更新使用 `npm run version:set -- <版本号>`。

正式构建、签名、安装包托管、验证包与 MSIX 的步骤见 [安装与发布](packaging/README.md)。正式提交前运行 `npm run release:check`；完整依赖扫描使用 `npm run audit:release`，需要预先安装 `cargo-audit`（`cargo install cargo-audit --locked`）。第三方许可通过 `npm run notices:generate` 维护并随应用分发。

没有正式签名与发布地址时，只能生成验证包。当前没有后台自动升级服务，设置中的反馈与新版下载入口由发布配置提供。

项目规则见 [AGENTS.md](AGENTS.md)，架构入口见 [代码导航](design/engineering/architecture.md)，版本变化见 [更新记录](CHANGELOG.md)。
