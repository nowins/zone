# Zone 安装与发布

首发优先使用 Microsoft Store 的 **MSIX** 路线。商店负责正式签名、安装包托管和更新分发；开发者仍负责 Partner Center 身份、版本、隐私与支持资料，以及升级兼容性。现有 NSIS 路线保留为独立分发选项。

## 版本与 MSIX 标识

版本事实源为 `package.json`、锁文件、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 和 `src/app/releaseInfo.ts`。使用 `npm run version:set -- 1.0.1` 统一更新；构建与测试检查一致性。MSIX 打包时将三段版本映射为四段 `1.0.1.0`，第四段保留为零；商店版本第一段必须非零，各段不得超过 65535。

应用的 `src-tauri/Cargo.lock` 与 npm 锁文件都纳入版本控制，原生 CI／构建使用 `--locked`。依赖更新须显式更新锁文件、运行 `npm run notices:generate` 核对许可变化，再完成检查与产物 smoke；不能通过删除锁文件或跳过许可检查让构建通过。`version:set` 同步锁文件中应用自身的版本。

正式发布机通过环境变量配置：

| 变量 | 内容 |
| --- | --- |
| `ZONE_MSIX_PACKAGE_NAME` | Partner Center 产品标识中的包名称 |
| `ZONE_MSIX_PUBLISHER` | 产品标识中的发布者 DN，通常形如 `CN=<GUID>` |
| `ZONE_MSIX_PUBLISHER_DISPLAY_NAME` | 真实发布者显示名称 |
| `ZONE_PRIVACY_URL` | 公开 HTTPS 隐私政策 |
| `ZONE_SUPPORT_URL` | 公开 HTTPS 支持或反馈入口 |
| `ZONE_DOWNLOAD_URL` | 可选的商店产品页或下载入口 |
| `ZONE_WEBSITE_URL` | 可选的介绍页 |

MSIX 商店构建不要求 `ZONE_CERT_THUMBPRINT` 或 `ZONE_INSTALLER_URL`，不能用占位标识提交。设置页外链随构建注入；未配置时隐藏，本地隐私说明仍可用。隐私与支持页面可用 GitHub Pages，反馈可用公开 Issues；只走商店时无需另行托管安装包。

## 商店 MSIX 与本地验证包

1. 在 Partner Center 注册并保留应用名称，复制真实产品标识。
2. 运行 `npm run release:check` 检查 MSIX 身份、版本与地址格式；它不证明地址已上线或产品标识已经注册。
3. 运行 `npm run package:msix:store`，先执行依赖审计，再完整构建原生程序并打包。上传包不使用本机开发证书，由商店认证后重新签名。
4. 完成隔离系统验收，上传 MSIX 到 Partner Center，补齐描述、截图、分级与认证资料。后续版本提升版本号并重新提交，商店负责更新分发；应用仍负责数据库迁移和旧设置兼容。

`npm run package:msix` 生成已签名的 **本地开发验证包**，默认标识 `ZonePlayer.Validation`，与商店身份区分。证书私钥保存在忽略的 `.tmp/msix-certificates/`，只供本地测试；产物同目录仅分发公钥 `development.cer`。不要把开发证书信任安装到日常宿主机，只在专用测试虚拟机使用。自定义开发标识时须同时传 `-PackageName`、`-Publisher` 与 `-PublisherDisplayName`。

需要 Microsoft WinApp CLI 0.6 或更新版：`winget install --id Microsoft.WinAppCLI -e`。产物按用途、四段版本、构建 ID 保存到 `packaging/dist/msix/`，包含 MSIX、SHA256 与 `release-report.json`。保留每次构建，避免覆盖旧包。开发 `-SkipBuild` 仅复用版本匹配的已验证 exe；商店模式要求完整构建。打包失败不能复用旧 exe，也不能将报告标成已可发布。

MSIX 优先使用系统 Evergreen WebView2，让系统继续自动更新运行时；系统缺失时使用包内 `WebView2/` 的离线固定版本，无需网络下载或额外管理员安装。`webview_runtime.rs` 在创建 Tauri 窗口前检测运行时，只选择主程序相邻目录，不覆盖显式的 WebView2 路径配置。打包脚本从 `webview2-runtime.json` 指定的微软地址取得 CAB，校验 SHA256、主程序微软签名与版本，再完整保留运行时资源和许可文件。运行时增大包体积，固定版本不会自动更新；每次发布前核对微软最新稳定版与安全公告，必要时更新固定版本、官方地址和校验值，并重新进行缺失运行时测试。缓存位于忽略的 `.tmp/msix-webview2-cache/`，损坏缓存使打包失败。

Windows 10 和缺失运行时的环境必须从原始快照实测；不要提前安装运行时再把结果算作缺失环境通过。单次构建报告保留实际运行时版本和来源，不自动把其他产物的验收结果算成本次通过。

依据：[微软 MSIX 包要求](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/package-version-numbering)、[微软商店签名说明](https://learn.microsoft.com/en-us/windows/msix/package/sign-msix-package-guide)、[更新分发机制](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app#step-5-set-up-auto-update)、[WebView2 分发](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)。

## Hyper-V 安装、升级与卸载矩阵

`npm run test:msix:hyperv -- -Inventory` 只读取已有虚拟机。真正测试需要两台专用 Windows 10/11 x64 客户端虚拟机、可恢复的干净快照，以及具有管理员权限的本地测试账号。常规 GitHub Actions x64 Windows 镜像是 Windows Server，不能代替客户端验收。

初次准备可由脚本或代理完成，但 Windows 原版 ISO/已安装 VHDX、许可选择与必要管理员授权必须具备。不要复用业务虚拟机：使用新建的专用虚拟机，Notes 必须明确设为 `Zone MSIX disposable test VM`。登录测试账号，在未安装 Zone 的状态保存干净快照；需要桌面启动检查，因此快照恢复后测试账号须有已登录桌面。当前脚本执行生命周期测试，不负责从 ISO 自动安装操作系统。

复制 `packaging/hyperv-matrix.example.json` 到忽略的 `.tmp/msix-hyperv-config/`，填写准确的虚拟机 GUID 和快照 GUID。在宿主机当前账号下用 `Get-Credential | Export-Clixml <credentialFile>` 保存来宾凭据；Windows DPAPI 将凭据绑定到当前用户和机器，不在聊天、仓库或测试报告中保存密码。

```powershell
npm run test:msix:hyperv -- -Config .tmp/msix-hyperv-config/matrix.json -BaselinePackage <旧版.msix> -CandidatePackage <新版.msix> -Certificate <development.cer> -Preflight
npm run test:msix:hyperv -- -Config .tmp/msix-hyperv-config/matrix.json -BaselinePackage <旧版.msix> -CandidatePackage <新版.msix> -Certificate <development.cer>
```

旧版和新版须同包名称、同发布者、均为 x64，且新版版本更高。预检在任何快照还原前检查矩阵全部成员；未标记的虚拟机、缺失快照、错误凭据格式或不匹配包都会停止。正式执行逐台还原指定快照，通过 PowerShell Direct 复制开发包和公钥证书，仅在隔离虚拟机内提升权限导入公钥信任。生命周期任务在测试账号已登录桌面中以普通权限执行，并检查自身没有管理员令牌：

- 安装旧版，核对包版本和注册。
- 从应用入口启动，确认真实窗口和包数据目录中的 `zone.sqlite`。
- 保存包内测试标记与数据库文件校验值，升级新版；在新版首次启动前检查既有数据完整保留。
- 启动新版，检查存活窗口和数据库目录。
- 卸载，检查包注册、开始菜单入口和包内测试标记清理，原始 WAV 源文件保持不变。

还原后自动启动处于关机或已保存状态的虚拟机，暂停状态则恢复运行；不支持的状态明确失败，启动前再次核对专用标记。测试结束关闭专用虚拟机，报告写入忽略的 `.tmp/msix-hyperv/`；失败、超时或未执行流程均不能标成通过。这套生命周期检查不替代真实播放、数据库语义迁移、无 WebView2 环境以及商店服务端更新测试。MSIX 更新保留包内数据；正常卸载会清理包内应用数据，媒体源文件不属于应用包。用户需知晓收藏、设置等卸载语义；不通过卸载脚本额外清理媒体或宿主机数据库。

## GitHub CI 与原生产物测试

`.github/workflows/windows-ci.yml` 复用同一 Windows 工作流，检查 PR 的准确 head SHA 或被推送的 SHA。基础检查后，`npm run build:ci:native` 从现有 Tauri 配置覆盖独立 CI 身份／名称并执行 release `--no-bundle` 构建；不改 CSP、capabilities，不增加测试命令和生产后门。每次身份为 `com.zone.player.ci.run-*`。原生进程 AppUserModelId、SMTC、HKCU 注册表及开始菜单快捷方式均使用配置中的身份；仅正式 `com.zone.player` 保留 `Zone.lnk` 和旧 exe 名称别名，其他身份使用 `Zone-<identifier>.lnk`，不得占用正式入口。

产物清单格式为 `ZoneNativeCI` v2，包含 Shell 身份声明；测试入口拒绝旧格式。每次启动前后读取正式两项注册表及 `Zone.lnk` 的目标、图标、AppUserModelId 和文件哈希，要求完全不变；同时验证本次独立快捷方式和注册表确实指向同一 exe。前后快照随诊断上传，结果必须有 `coverage.shellIsolation = true`。测试不自动清理或恢复正式入口，发现变化时保留证据并失败。

构建输出在忽略的 `.tmp/ci-native/`，artifact 包含真正的 `zone-player.exe`、第三方许可、锁文件和 `build-info.json`（来源 SHA、版本、身份及 exe SHA256）。这是需要 Windows x64 与 WebView2 的未签名测试程序，不是安装包或正式发布。工作流只需 `contents: read`，不使用发布凭据；Actions 固定完整 SHA，缓存按锁文件／工具链区分，Cargo 缓存仅主分支成功运行保存。旧运行自动取消，步骤和总任务均有限时；可下载 exe 和诊断 artifact 保留 7 天，状态以 smoke 结果为准，失败构建不复用旧 exe。

`scripts/ci/setup-webdriver.ps1` 检测已安装的 WebView2，复用或从微软下载版本匹配的 Edge WebDriver，并验证微软签名。不安装或更新系统浏览器。`npm run test:ci:artifact` 直接以 WebDriver 启动本次 exe；测试前校验 hash、内嵌 CI 身份并拒绝已有测试资料目录，不能指向正常应用。测试期间使用专用 WebView2 profile 和两个生成的真实 PCM WAV 文件，原生数据库位于该 CI 身份的应用数据目录；测试不删除或扫描用户曲库，也不自动清理其他身份目录。

自动流程包括：空库启动；调用正式扫描命令并显示两首夹具歌曲；通过正式本地音频协议读取 Range；从真实界面喜欢歌曲和创建列表；确认写入 SQLite；通过真实窗口关闭控件退出并核实进程结束；重新启动同一 exe，核对歌曲、喜欢、列表和关闭偏好。没有 mock IPC、替换前端或注入额外 Rust 测试宿主。失败尽量保存截图、HTML、驱动日志及 `result.json`，结果绑定来源和 exe hash，WebView2 profile 不上传。

PR 和每晚 UTC 02:00 的运行增加独立故障 job，在另一台干净 runner 下载前一 job 的准确 artifact ID，再运行同一 exe。故障仅作用于该身份的合成资料：真实 SQLite 写锁使保存失败，检查原状态、未保存提示、释放锁后的界面重试；不可用来源扫描须拒绝并保留曲库与列表。使用 `npm run test:ci:faults` 本地复现，手动运行可选择 faults。定时入口须该工作流先经审查进入默认分支才生效；不测试宿主 ACL、真实磁盘满或任意用户数据库损坏。

本地开发代理可使用项目 [zone-qa 技能](../.agents/skills/zone-qa/SKILL.md) 和 `npm run qa -- --layer plan --base origin/main` 按差异建议选测。`fast`、`artifact`、`faults` 和 `auto` 调用确定性入口，输出 `.tmp/qa/` 的退出码、日志、来源／产物 hash 及通过／失败／未执行矩阵。必要专用层未执行时返回 incomplete；没有“AI 认为通过”的覆盖开关，也不自动接受视觉／性能基线。完整环境前提与停止条件见技能，所有推送／设备／安装动作仍沿用本任务和项目授权。

本地复现：先运行 `npm run build:ci:native`，再运行 `./scripts/ci/setup-webdriver.ps1` 和 `npm run test:ci:artifact`。需要可交互的 Windows 桌面；普通实例可以保持运行。若正常 release exe 正被使用，可给构建命令设置独立 `CARGO_TARGET_DIR`，不要结束用户应用。重跑 smoke 前重新构建会获得新身份；已有测试数据保留供诊断。

该 smoke 不证明扬声器可听输出、蓝牙／耳机切换、休眠恢复、SMTC 全矩阵、长时资源稳定性、全部键盘／动效、缺失 WebView2 或 MSIX 安装升级。后者继续使用下文的 Windows 10/11 客户端 Hyper-V 矩阵和硬件验收。正式发布仍须完整依赖审计、真实商店配置及发布守卫，不把 CI 通过当作商店发布批准。

依据：[微软 WebView2 WebDriver](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webdriver)、[WebView2 driver 配置](https://learn.microsoft.com/en-us/microsoft-edge/webdriver/capabilities-edge-options)。

## NSIS 独立分发

`npm run tauri:build` 生成当前用户 NSIS 包，WebView2 使用在线引导。保留的 `npm run tauri:build:store` 是旧 EXE 商店路线：自包含 WebView2、用户/全机安装、静默参数 `/S`。其预检改用 `npm run release:check:nsis`。

EXE 商店路线仍要求真实 `ZONE_PUBLISHER`、可信 `ZONE_CERT_THUMBPRINT`、不可变版本化 `ZONE_INSTALLER_URL`、隐私/支持/下载地址，开发者自行托管和提供后续更新。缺少条件时仅 `-- -AllowUnsigned` 可显式生成验证包。NSIS 产物保留在 `packaging/dist/store/<version>/`；不覆盖已提交的同版本 URL。相关要求见[微软 EXE/MSI 包要求](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements)。当前 NSIS 尚未接入应用内自动更新。

## 依赖、图标与商店素材

- `npm run audit:release` 检查 npm 与实际 Win32 Rust 构建图，需先 `cargo install cargo-audit --locked`。漏洞、不健全或撤回版本使检查失败，不忽略公告 ID。Tauri/Symphonia 的部分间接依赖有停止维护警告，保留并跟踪上游，不称为已消除。
- 第三方许可用 `npm run notices:generate` 维护，正式构建核对并随包分发。
- 图标事实源是 `app-icon.png`；`packaging/generate-icons.ps1` 更新 Tauri 图标与 MSIX 资产。
- 商店列表准备真实截图、简短描述、关键词和分级；建议覆盖 quickplay、收藏、正在播放、歌词和播客。
- 应用回归覆盖默认 1180×760、最小 920×620、键盘、减少动态效果、常用 DPI、音频格式、离线目录、迁移与播客下载。
- 当前音乐、播客与补充资料共用 `zone.sqlite`，旧库仅作迁移源。MSIX/NSIS 转换前验证数据路径与迁移，不能把打包切换视为自动完成旧数据迁移。
