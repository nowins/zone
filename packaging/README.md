# Zone 安装与发布

三条产物线，共用同一份 release 构建：


注意：普通 NSIS 与商店 NSIS 输出同名，先后构建会互相覆盖，发布前按需重新构建。

## 标准 Windows 安装

`npm run tauri:build` 产出 NSIS 安装器（`targets` 只保留 NSIS，不维护 MSI）：

- 当前用户安装（免管理员）、中英双语跟随系统、lzma 压缩、开始菜单项。
- WebView2 使用在线引导（`embedBootstrapper`），安装包体积小，首次安装需联网。
- 版本号取自 `src-tauri/tauri.conf.json` 的 `version`（三段式）。发版时同步修改该文件与 `src-tauri/Cargo.toml`。

## 商店路线 A：Win32 安装包直接上架（推荐先走这条）

微软商店支持直接提交 Win32 安装器，无需 MSIX。商店托管下载，后续版本更新走应用自身的更新机制。

1. 构建：`npm run tauri:build:store`。它叠加 `src-tauri/tauri.microsoftstore.conf.json`，关键差异是 `webviewInstallMode = offlineInstaller`（安装包内嵌 WebView2，约 200 MB），商店要求安装器自包含、不依赖外网引导。
2. 确认 `tauri.conf.json` 的 `bundle.publisher` 与 Partner Center 的发布者显示名完全一致（不能与应用同名）。
3. Partner Center（partner.microsoft.com）注册开发者账号 → 保留应用名称 Zone → 创建应用 → 在“程序包”页上传 `Zone_<ver>_x64-setup.exe`。
4. 按向导完成年龄分级、可见性、定价与商店列表（中文为主，可附英文）。列表素材见下文“资产清单”。

## 商店路线 B：MSIX（商店托管更新）

MSIX 由商店负责安装与增量更新，体验更接近原生商店应用。本仓库用微软 winapp CLI 打包：

1. 安装工具（需 Windows 11）：`winget install --id Microsoft.WinAppCli -e`
2. 打包：`npm run package:msix`。脚本（`packaging/build-msix.ps1`）会：
   - `tauri build --no-bundle` 产出 release exe（`-SkipBuild` 可跳过）；
   - 把 `tauri.conf.json` 的三段版本盖章成 MSIX 要求的四段（x.y.z.0），只改写 staging 副本；
   - 组装 `.staging/`（exe + 清单 + Assets），生成/复用开发证书（`devcert.pfx`，git 已忽略）；
   - `winapp package` 产出并签名 `packaging/dist/Zone_<ver>.0_x64.msix`。
3. 本机旁加载验证（需管理员 PowerShell，一次性）：
   `winapp cert install packaging\devcert.pfx`，然后 `Add-AppxPackage packaging\dist\Zone_0.1.0.0_x64.msix`。
4. 上架前，把 Partner Center“产品标识”页的值写进 `packaging/Package.appxmanifest`（或用脚本参数 `-PackageName` / `-Publisher` 覆盖）：
   - `Identity/@Name` ← 包/标识/名称
   - `Identity/@Publisher` ← 包/标识/发布者（形如 `CN=AAAAAAAA-....`）
   - `PublisherDisplayName` ← 发布者显示名
5. 提交商店时无需自己签名（商店 ingestion 会重签）；`-Cert` 仅用于本机/内测分发。

MSIX 版行为差异：应用数据（localStorage、podcasts.sqlite、封面缓存等）落在 `%LOCALAPPDATA%\Packages\<PackageFamilyName>\` 下，与 NSIS 安装版互不影响；WebView2 依赖系统自带 Evergreen 运行时（Win11 预装）。

## 图标与商店资产

- 唯一图标源：仓库根 `app-icon.png`（1024×1024，RGBA）。改动后运行 `npx tauri icon` 重新生成 `src-tauri/icons/` 全套（含 Square44/150/310 与 StoreLogo）。
- MSIX 额外资产在 `packaging/Assets/`：方形磁贴来自 `src-tauri/icons/`，`Wide310x150Logo.png` 与 `SplashScreen.png` 由 `.tmp` 里的 PIL 脚本按品牌底色 #1B1A19 合成（源也是 `app-icon.png`）。
- 商店列表还需要：至少 1 张 1280×720 截图（建议 3–5 张：quickplay、正在播放、歌词模式、播客）、简短的商店描述与搜索关键词。截图可在验收时从 `npm run tauri:dev` 或安装后的应用里截取。

## 代码签名

- 未签名的 NSIS 安装器会被 SmartScreen 提示。正式分发建议用 OV/EV 代码签名证书对 setup.exe 与 zone-player.exe 签名（`signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 ...`），此步骤放在持有证书的发布机上执行。
- MSIX 旁加载分发必须签名；提交商店可不签。

## 当前状态（2026-08 验证记录）

- [x] NSIS（在线引导）+ MSI 构建通过
- [x] 商店自包含 NSIS 构建通过
- [x] MSIX 打包 + 开发证书签名通过（包结构校验完整）
- [ ] 旁加载安装实测（需一条管理员命令信任 devcert，见上）
- [ ] Partner Center 账号、保留应用名、回填 Identity 值
- [ ] 商店列表截图与文案
