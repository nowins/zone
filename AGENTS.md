# Zone 项目指南

Zone 是受 Microsoft Zune 4.8 启发的本地音乐播放器，使用 Tauri 2 + React 18 + TypeScript strict + Vite。优先打磨本地音乐、quickplay 磁贴、播客与正在播放体验，保持 Zune 的排版和克制动效。

## 如何使用这些规则

- 本文件放全项目约束、工作流程与验证入口。开始修改前按下表读取相关专题；跨模块任务读取所有涉及的专题，无需为无关任务通读全部文档。
- 专题规则按功能适用，包含分散在前端、Rust、样式与测试中的实现；不要仅根据当前文件目录判断是否适用。
- “必须/不得”与行为、安全边界是约束；“当前实现/参数/定位地图”是可更新的说明。合理的实现选择、参数调优和可逆修复可在任务范围内自行完成，不因此反复请求确认。
- 用户在当前会话中的明确指令优先于本仓库约定。发现文档与源码不符时核实并同步文档；不要把实现中的缺陷当作取消安全或产品约束的依据。

| 涉及的任务 | 修改前读取 |
| --- | --- |
| 模块定位、App 接线、架构或跨模块重构 | [代码导航与架构](design/engineering/architecture.md) |
| 音乐播放控制、Web Audio、节拍分析、拼贴与光焰 | [播放与正在播放视觉](design/engineering/playback-visuals.md) |
| 歌词加载、Provider、解析、缓存、同步或导出 | [歌词子系统](design/engineering/lyrics.md) |
| 播客页面、单集/队列/进度、RSS、代理或离线下载 | [播客子系统](design/engineering/podcasts.md) |
| 音乐数据库、旧状态迁移、曲库扫描、保存或诊断 | [持久化与诊断](design/engineering/persistence.md) |
| 组件、页面、磁贴、文案或视觉样式 | [组件与设计规范](design/component-guidelines.md) |
| 动效、页面导航、Presence、FLIP 或 reduced-motion | [动效系统](design/motion-system.md) |
| 安装器、MSIX、商店、图标或发布配置 | [安装与发布](packaging/README.md) |

## 全项目约束

- 产品：本地音乐优先，收藏按专辑/艺术家/歌曲/播放列表组织，quickplay 支持固定内容。播客按“收听 / 发现 / 资料库 / 播放列表”组织，搜索和手动 RSS 是辅助入口。
- 视觉：以 Zune 4.8 为第一参照，使用真实封面与媒体派生色、克制的控制区和有目的的动效；避免玻璃拟态仪表盘、卡片堆砌与大块解释性文案。功能性文字不能破损重叠或溢出，保持桌面键盘/鼠标交互预期。
- 语言：新增功能性 UI 文案必须中文，文档使用中文，代码注释使用英文。关键文案由 `tests/localization.test.mjs` 守卫。
- 播放：App 保持唯一的主 `<audio>`；音乐与播客共用 transport，但播客的队列、收藏语义、统计、倍速与进度独立。不得让播客触发音乐节拍预分析。
- 可视化：必须来自真实音频；静音或无信号时不得用假动画冒充响应。暂停、隐藏及减少动态效果时按专题规则收敛停转。逐帧数据通过 ref/DOM/Canvas 或 `visualizerBus` 传递，不用 React state 驱动。
- 状态：音乐、播客和补充资料共用 `zone.sqlite`，按表和业务语义隔离；`podcasts.sqlite` 等旧库与旧音乐 localStorage 只作迁移源。迁移失败保留原始数据，恢复未成功时暂停自动写回，不能误清理其他类别的状态。
- 网络与文件：在线歌词、播客 RSS/音频/封面经各自 Rust 受控入口；保留 URL/DNS/重定向校验、响应上限与下载路径守卫。协议、网络、导出或删除相关改动先读对应专题。
- Tauri：不扩大已有权限或资源访问面。CSP 只允许本地资源与受控媒体协议，开发配置额外允许 Vite 热更新；`assetProtocol.scope` 初始为空，由 Rust 原生命令仅放行返回的真实图片文件。capabilities 以 `src-tauri/capabilities/default.json` 为准，包含 `core:default`、窗口操作与 `opener:default`，不因新功能随意扩权。
- 复用：封面使用 `Cover`，常规动作使用 `Button`，加载使用 `MetroLoader`，通用深色对话框使用 `Dialog`；已有例外及接线见组件规范。
- 动效：token 的唯一事实源是 `src/motion/tokens.ts`。页面切换走 `requestNavigation`，浮层退场走 `Presence`，共享封面走 FLIP；新增动效接入统一 reduced-motion 规则。
- 测试模块导入：`src/utils/`、`src/motion/` 等经 `tsconfig.test.json` 编译后被 Node 直接运行的 TS 模块，相互相对导入使用显式 `.js` 后缀。React 侧现有 `.tsx` 导入不带后缀。

## 工作流程与授权

- 用户提出实施或修复请求后，推进到完成必要实现与验证。先查源码和现有约定，在授权范围内自行处理常规选择；仅当缺少会实质改变结果的信息或必要授权时询问，并说明具体原因。
- 不自动启动 `npm run dev`、`npm run tauri:dev` 或其他常驻服务。用户已明确授权本轮/当前任务启动或交互审查时，授权持续有效，不重复询问；先检查现有实例，避免重复启动。
- 每个功能或聚焦修复单独提交。提交主题统一为 `<type>: <English subject>`：`type` 取 `feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`chore`，主题为英文祈使句、单行、不加句号。正文可选，需要记录取舍或验证方式时用英文短句列出。提交信息按此约定书写，不随「文档使用中文」规则改写；更早的提交未统一，不追溯改写或据此回退。
- 用户已授权：工作完成且适用验证通过后自动创建本地提交，无需再次验收或确认；用户明确要求暂不提交时除外。
- 只暂存属于当前功能的文件或修改片段，不混入、撤销或覆盖无关工作区改动。自动提交授权不包含推送、发布或部署。
- 必要验证失败或无法完成时保留改动，说明未完成项，不宣称验证通过；用户明确要求先提交时按该指令执行并注明验证限制。
- 交付说明改了什么、验证结果、必要限制与提交号。已通过的检查不因准备提交而重复运行，除非又有相关改动或新证据。

## 验证入口

按改动影响选择验证，专题要求补充在下表之上。纯文档不运行应用构建；源码/CSS 守卫不能替代真实行为或视觉验证，也不能只为消除失败而削弱断言。

| 改动范围 | 必要验证 |
| --- | --- |
| 仅文档/项目指引 | `git diff --check`；核对链接、路径、命令与源码事实；检查规则迁移无遗漏或冲突 |
| 前端代码、样式、构建配置 | `npm run build`；被测逻辑、UI/CSS 结构或接线变化同时 `npm test` |
| Rust 代码 | 在 `src-tauri/` 运行 `cargo check`；行为变化补充并运行相关 `cargo test --lib` 测试 |
| 协议、Tauri 配置、发布路径敏感改动 | `npx tauri build --no-bundle`，并完成相关前端/Rust 检查 |
| 界面、交互与动效 | 检查相关真实流程、键盘焦点、减少动态效果以及默认 1180×760 / 最小 920×620 窗口；具体场景见专题 |
| 音频可视化与自定义播放协议 | 真实 Tauri 播放验证；纯浏览器 Vite 无法完整验证协议/CORS 行为 |

命令以 `package.json` 与 `src-tauri/Cargo.toml` 为准：

- `npm run build`：TypeScript 检查后由 Vite 构建。
- `npm test`（`test:visualizer`）：`tsc -p tsconfig.test.json` 后执行 `node --test tests/*.test.mjs`。纯函数和选定 hook 从 `.tmp/visualizer-tests/` 导入，新被测模块需维护编译清单；源码/CSS 守卫读取源码；React 运行时测试另用 esbuild、JSDOM、StrictMode 和可控动画时钟。
- `cargo test --lib`：Rust 各模块内的单元测试。真实播客网络 smoke 默认忽略，仅在显式设置 `ZONE_PODCAST_LIVE=1` 后运行。
- `npm run tauri:build` / `npm run tauri:build:store` / `npm run package:msix`：标准 NSIS、商店 NSIS 与 MSIX。正式商店脚本检查签名和地址并单独留存版本产物；缺少条件时仅能显式生成验证包。`npm run release:check` 检查发布配置，`npm run audit:release` 检查实际 Win32 依赖，详见发布文档。

## 文档与维护

- 根目录保持简明；专题规则在 `design/engineering/`，界面/动效规范在 `design/`，发布在 `packaging/README.md`，均纳入版本控制。保持每条详细规则有明确归属，根目录仅作必要摘要。
- 文档记录长期行为边界与定位入口，不复制易失效的文件行数、命令数量或完整源码。参数表标明事实源，调整时同步对应专题；修复经过和截图放在本地记录，不自动升级为永久禁令。
- `docs/` 是被忽略的本地探索与视觉证据，其他 checkout 不保证存在。可参考其中已有资料，但必需规则和验证步骤不能只放在那里。
- `.tmp/` 是被忽略的测试/临时产物目录，不将其中生成文件作为正式源码修改或提交。`Cargo.lock` 按仓库现有 `.gitignore` 不提交。
- 图标事实源是根目录 `app-icon.png`，修改后 `npx tauri icon` 生成 `src-tauri/icons/`；MSIX 资产在 `packaging/Assets/`。
- 修改结构、命令、约定或数据流时更新所属文档；只有全局规则或入口改变才同步根目录，不在多个文件重复维护同一细节。
