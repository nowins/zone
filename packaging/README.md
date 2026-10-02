# Zone 安装与发布

首发使用 Microsoft Store 的 Win32 NSIS 路线。构建成功不代表已具备提交条件：正式包需要受信任的代码签名、真实发布者、公开 HTTPS 安装包地址、隐私政策与支持入口。

## 版本与发布配置

版本同时记录在 `package.json`、锁文件、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 和 `src/app/releaseInfo.ts`。使用 `npm run version:set -- 0.1.2` 统一更新；构建与测试会检查一致性。

发布机通过环境变量配置以下信息，不把证书私钥或密码提交到仓库：

| 变量 | 内容 |
| --- | --- |
| `ZONE_PUBLISHER` | Partner Center 发布者名称，须与代码签名证书主体一致 |
| `ZONE_CERT_THUMBPRINT` | Windows 证书库中的受信任代码签名证书指纹，须包含私钥与代码签名用途 |
| `ZONE_INSTALLER_URL` | 开发者托管的版本化 HTTPS 安装包地址，以 `Zone_<version>_x64-setup.exe` 结尾 |
| `ZONE_PRIVACY_URL` | 公开隐私政策地址 |
| `ZONE_SUPPORT_URL` | 真实支持或反馈地址 |
| `ZONE_DOWNLOAD_URL` | 新版下载入口，应用不会在后台自动升级 |

商店脚本将隐私、反馈和下载地址注入设置页；普通构建可使用 `VITE_ZONE_PRIVACY_URL`、`VITE_ZONE_SUPPORT_URL`、`VITE_ZONE_DOWNLOAD_URL` 和可选 `VITE_ZONE_WEBSITE_URL`。未配置的外链入口不会显示，本地隐私说明始终可用。

## 商店 Win32 安装包

1. 运行 `npm run release:check` 检查版本、地址和证书。缺少条件、开发自签证书、过期或不受信任的证书都会停止。
2. 运行 `npm run tauri:build:store`。脚本叠加 `src-tauri/tauri.microsoftstore.conf.json`：WebView2 使用 `offlineInstaller`，安装器支持用户/全机安装，按语言环境使用中英文，静默命令为 `Zone_<version>_x64-setup.exe /S`（大写）。正式构建会签名并验证原生 exe 与安装器。
3. 产物保存到 `packaging/dist/store/<version>/`，包含 SHA256、签名状态与待验证项目的 `release-report.json`。禁止覆盖内容不同的同版本产物。普通与商店 NSIS 在 Tauri 默认输出目录同名，发布只取上述保留目录中的商店产物。
4. 在隔离的 Windows 10/11 x64 系统验证安装、升级、启动、静默安装和卸载，尤其验证没有 WebView2 的环境。升级保留用户数据；卸载后确认可执行文件与快捷方式清理、用户数据策略符合列表描述。安装器及其所有可执行负载均须满足可信签名要求。
5. 上传到开发者维护的公开、不可变、版本化 HTTPS URL，核对下载文件 SHA256。Partner Center 提交安装包 URL、静默参数、真实支持和隐私地址，并完成名称、分级、列表与认证。相同 URL 不替换成新版本文件。

当前没有正式证书和托管地址时，可运行 `npm run tauri:build:store -- -AllowUnsigned` 生成完整自包含验证包；报告明确标记 `validationOnly: true`、`releaseReady: false`。它用于本机测试，不能提交为正式商店包。填写所有配置后仍须完成上传和隔离系统验收，配置校验不证明地址已上线。

依据：[Microsoft Win32 程序包要求](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements)、[Tauri 商店分发指南](https://v2.tauri.app/distribute/microsoft-store/)。Win32 安装包由开发者托管；后续更新也由开发者提供，本项目当前使用设置中的下载入口。

依赖检查使用 `npm run audit:release`，需要 `cargo install cargo-audit --locked`。Rust 审计按实际 Win32 构建图检查，不忽略公告 ID；漏洞、不健全或撤回版本使检查失败。当前 Tauri/Symphonia 的间接依赖仍有 `paste` 与五个 `unic-*` 停止维护警告，没有对应的安全修复版本；保留警告并跟踪上游升级。它们不能被描述为已消除的漏洞，也不应通过关闭审计来隐藏。

## 普通 NSIS 与 MSIX

`npm run tauri:build` 生成当前用户 NSIS 包，WebView2 使用 `embedBootstrapper` 在线引导，适用于独立分发。正式分发同样应配置可信签名，不将开发自签证书当成可信签名。

`npm run package:msix` 是另一条打包路线，需要 Microsoft WinApp CLI。脚本先检查版本并构建原生程序，再从 `packaging/Package.appxmanifest` 生成四段版本的 staging 清单；构建失败立即停止，不能误打包旧 exe。`-SkipBuild` 仅用于明确复用已验证的 release 程序。`-PackageName` / `-Publisher` 必须取 Partner Center 产品标识。默认开发证书只供本机旁加载；商店 MSIX 提交由微软重签。

MSIX 的应用数据受 Windows 包隔离，NSIS 数据位于应用数据目录。当前音乐、播客与补充资料共用 `zone.sqlite`，按表隔离；`podcasts.sqlite` 等旧库仅作为迁移源。打包或卸载脚本不得顺带清理用户数据库和媒体源文件。

## 图标、许可与商店素材

- 唯一图标源为根目录 `app-icon.png`。执行 `powershell -ExecutionPolicy Bypass -File packaging/generate-icons.ps1` 更新 Tauri 图标与 `packaging/Assets/`；`src-tauri/build.rs` 跟踪 ico 变更。
- 第三方许可随应用资源分发，生成命令与文件见 `packaging/generate-notices.mjs`。依赖更新后重新生成，正式构建自动核对。
- 商店列表准备至少一张 1280×720 的真实界面截图，建议覆盖 quickplay、收藏、正在播放、歌词与播客，并补齐简短描述、关键词和分级。截图使用最终构建，不使用原型替代已实现界面。
- 首发前测试默认 1180×760、最小 920×620、键盘焦点、减少动态效果、常用 DPI、多种音频格式、离线目录、数据库迁移和播客下载。当前机器检查不能替代 Windows 10/11 与干净系统安装矩阵。
