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

### Windows CI

[Windows CI](.github/workflows/windows-ci.yml) 在面向 `main` 的 PR、`main` 提交及手动触发时运行。保留前端构建、Node 回归和 Rust 检查／单测，再构建真正的 Tauri release exe，并对这个 exe 执行真实 WebView2、原生命令、SQLite 和重启恢复 smoke。

npm 与 Rust 依赖分别由已提交的 `package-lock.json` 和 `src-tauri/Cargo.lock` 固定，后者使干净 runner 的原生依赖和许可清单不随运行漂移。使用 Windows Server 2022、Node.js 24 LTS（至少 24.15.0）和 stable x64 Rust/MSVC，权限仅 `contents: read`；缓存按锁文件区分，仅主分支成功运行保存 Cargo 缓存。同一 PR／分支自动取消旧运行，总超时 60 分钟。exe、构建信息和诊断 artifact 保留 7 天。

产物采用独立 CI 身份和生成的 WAV 夹具，不访问真实曲库；自动检查扫描、歌曲显示、本地音频 Range、喜欢／列表保存、正常退出与新进程恢复。失败保存截图、页面、驱动日志和结构化结果。可听音频、设备切换、休眠、完整交互／动效及客户端安装升级仍需专门矩阵，不能由托管 Windows Server runner 代替。CI 不签名或发布，详见[产物测试与验证边界](packaging/README.md#github-ci-与原生产物测试)。

## 安装与发布

当前版本为 1.0.0，首发优先使用 Microsoft Store 的 MSIX 包。版本更新使用 `npm run version:set -- <版本号>`。

正式构建、签名、安装包托管、验证包与 MSIX 的步骤见 [安装与发布](packaging/README.md)。正式提交前运行 `npm run release:check`；完整依赖扫描使用 `npm run audit:release`，需要预先安装 `cargo-audit`（`cargo install cargo-audit --locked`）。第三方许可通过 `npm run notices:generate` 维护并随应用分发。

MSIX 商店负责正式签名、托管和更新分发。当前缺少 Partner Center 产品标识时，`npm run package:msix` 生成独立身份的本地验证包；`npm run package:msix:store` 用于商店上传。Hyper-V 生命周期测试入口为 `npm run test:msix:hyperv`，需要专用 Windows 10/11 测试系统，见发布文档。

项目规则见 [AGENTS.md](AGENTS.md)，架构入口见 [代码导航](design/engineering/architecture.md)，版本变化见 [更新记录](CHANGELOG.md)。
