# Zone 项目说明

本文档面向 AI 编码代理，假设读者对本项目一无所知。请遵循其中的真实项目约定（构建命令、目录结构、测试方式），它与用户对话中的直接指令不冲突时均应遵守。

## 项目概览

Zone 是一个受 Microsoft Zune 4.8 启发的本地音乐播放器，技术栈为 Tauri 2 + React 18 + TypeScript + Vite。首要目标是打磨本地音乐播放体验，UI/UX 贴近 Zune，而不是做成一个普通的桌面播放器。

产品侧重要点：

- 本地音乐播放优先。支持格式：`mp3`、`flac`、`m4a`、`aac`、`wav`、`ogg`（见 `src-tauri/src/lib.rs` 的 `is_supported_audio`）。
- Zune 风格的收藏导航：专辑、艺术家、歌曲、播放列表。
- Zune 风格的 quickplay 首页：固定（pin）的曲目/专辑/艺术家/播放列表磁贴。
- 丰富的「正在播放」页面：封面拼贴背景、克制的控制区、细腻排版、音频响应式底部光焰。
- 内嵌歌词模式：同一空间内的第二种状态，支持逐行/逐词同步（参考 `docs/lyrics-experience-plan.md`）。
- 平滑、克制的动效。避免浮夸或明显现代的效果，不破坏 Zune 参照。
- 界面文案使用中文。`tests/localization.test.mjs` 会断言关键界面文案不出现英文回退，新增功能性 UI 文案必须使用中文。

## 技术栈

- 前端：React 18、TypeScript（strict）、Vite 5（`@vitejs/plugin-react`）、`lucide-react` 图标、`@tauri-apps/api`。
- 桌面壳：Tauri 2.9。窗口 1180×760（最小 920×620），无边框（`decorations: false`），自带 `Titlebar` 组件。
- Rust 端（`src-tauri/`）：
  - `lofty` 0.22：音频标签与内嵌封面/歌词读取。
  - `encoding_rs`：修复老旧中文元数据的 GBK 乱码。
  - `walkdir`：曲库扫描。
  - `rfd`：文件夹/歌词文件选择对话框。
  - `reqwest`（rustls）：在线歌词请求（经 Rust 端中转，见下文安全约束）。
  - `notify`：递归监听已添加的音乐目录，驱动防抖后的曲库自动刷新。
  - `windows` 0.61（仅 Windows）：系统媒体传输控制（SMTC）集成。

## 构建与测试命令

- `npm run build`：`tsc && vite build`，前端类型检查加构建。
- `npm test`（等同 `npm run test:visualizer`）：先用 `tsconfig.test.json` 把选定的 `src/utils/*.ts` 编译到 `.tmp/visualizer-tests/`，再执行 `node --test tests/*.test.mjs`。
- `cargo check`：在 `src-tauri/` 目录内运行，Rust 改动后必跑。
- `npx tauri build --no-bundle`：协议、Tauri 配置或发布路径敏感改动后运行。
- `npm run dev` / `npm run tauri:dev`：见下方运行策略，不要自动启动。

## 运行策略

- 不要自动为本项目启动开发服务器。
- 只有在用户明确要求时才运行 `npm run dev`、`npm run tauri:dev` 或其他常驻服务。
- 安全的验证命令：`npm run build`、`cargo check`（`src-tauri` 内）、`npx tauri build --no-bundle`。

## Git 工作流

- 每个被确认的功能或聚焦的修复单独一个提交，提交信息简洁、有描述性。
- 在用户明确确认功能通过验收之前，不要提交。
- 验收后，只暂存属于该功能的文件并自动提交，不再二次确认。
- 不要把无关的工作区改动混入功能提交。

## 代码结构

- `src/App.tsx`：顶层应用状态（约 1200 行）。负责曲库扫描编排、播放队列、当前曲目、随机/重复、进度、音量、播放活动统计（playCount/skip）、播放列表持久化、home pins、Web Audio 分析器搭建与可视化采样、节拍分析。
- `src/types.ts`：所有共享类型定义（Track、Playlist/SmartPlaylist、HomePin、LyricsDocument/LyricsProvider 等）。`AppPage = "quickplay" | "collection" | "nowPlaying" | "settings"`。
- `src/constants.ts`：`STORAGE_KEY = "zone-player-state-v1"`、`LIBRARY_SCHEMA_VERSION = 5`、`DEFAULT_PLAYLIST_ID = "favorites"`、`MAX_HOME_PINS = 12`、`VISUALIZER_SAMPLE_COUNT = 180`。
- `src/views/`：页面级视图。
  - `QuickplayView.tsx`：Zune quickplay 首页，可固定/排序磁贴。
  - `LibraryView.tsx`：收藏页标签切换（专辑/艺术家/歌曲/播放列表），保持轻薄并向下委托。
  - `ArtistBrowser.tsx`：Zune 风格艺术家导航（艺术家 → 专辑 → 歌曲）。
  - `PlaylistBrowser.tsx`：当前队列与已存播放列表（含智能播放列表）。
  - `NowPlayingView.tsx`：全屏正在播放。Canvas 封面拼贴背景、队列浮层、曲目卡片、收藏按钮、进度/走带控制、歌词模式切换。
  - `SettingsView.tsx`：音乐文件夹管理与在线歌词来源（provider）启用/优先级设置。
- `src/components/`：可复用 UI。包括 `Cover`、`PlayerBar`、`TransportControls`、`PlaybackProgress`、`ContextMenu`、`InfoPanel`、`Titlebar`、`EmptyState`、`PlaylistDialog`、`SmartPlaylistDialog`、`LyricsStage`（歌词舞台）、`NowPlayingMosaicCanvas` 与 `AudioGlowCanvas`（正在播放的两个 Canvas 视觉层）。
- `src/hooks/`：
  - `useLibraryWatcher.ts`：配置 Rust 目录监听、接收文件变化事件并在 800ms 防抖后触发曲库刷新。
  - `useLyrics.ts`：歌词加载/缓存/在线搜索状态机（本地缓存键 `zone-local-lyrics-v1`）。
  - `useLyricsProviderSettings.ts`：歌词 provider 启用与优先级（键 `zone-lyrics-providers-v1`）。
  - `useSystemMedia.ts`：与 Rust 端 SMTC 集成（`update_system_media*` 命令与媒体按键事件）。
- `src/lyrics/providers.ts`：在线歌词 provider 定义与编排。自动查找按优先级回退并在高置信命中后停止；手动在线搜索并行查询全部已启用来源。请求统一经 Rust 命令 `request_lyrics_provider` 中转。
- `src/utils/`：纯逻辑模块（详见各测试）。
  - `music.ts`：专辑分组、曲目排序、播放列表默认值、`normalizePlaylists`。
  - `playback.ts`：队列移动/随机顺序/边界解析。
  - `smartPlaylist.ts`：智能播放列表规则求值与归一化。
  - `homePins.ts`：quickplay 固定项的归一化、移动、对账。
  - `visualizer.ts` / `beatAnalysis.ts` / `audioGlow.ts` / `nowPlayingWall.ts` / `nowPlayingCanvas.ts`：音频帧、节拍网格、Zune 光焰与封面拼贴的纯计算部分。
  - `lyrics.ts` / `lyricsProviders.ts` / `lyricsProviderSearch.ts` / `lyricsExport.ts` / `lyricsMotion.ts`：歌词解析（plain/line/word）、候选打分排序、多来源搜索编排、TTML/LRC 导出与真实逐词时间驱动的长音包络。
  - `demoLyrics.ts`：仅动效原型用的演示歌词。
- `src/styles.css`：按序 `@import` `src/styles/` 下的拆分 CSS：`base`、`collection`、`quickplay`、`player`、`now-playing`、`lyrics`、`overlays-settings`、`playlists`、`motion`、`animations-responsive`。
- `src-tauri/src/lib.rs`（约 1000 行）：Tauri 命令与自定义协议。
  - 命令：`select_music_folder`、`select_lyrics_file`、`export_lyrics_file`、`scan_library`、`watch_music_folders`、`load_local_lyrics`、`request_lyrics_provider`、`update_system_media`、`update_system_media_timeline`。
  - `zone-audio` 自定义协议（`serve_audio_protocol`）：CORS 安全的本地音频播放与 Web Audio 分析，含字节范围（`Accept-Ranges`/`Content-Range`）与正确的音频 content type。
  - 歌词：内嵌标签歌词、同目录 sidecar 歌词（`.ttml` 优先于 `.lrc`，大小写不敏感）、UTF-16/GBK 解码修复。
  - 封面提取与缓存（内嵌封面写入缓存目录）。
  - 文件内自带 Rust 单元测试（`#[cfg(test)]` 模块）。
- `src-tauri/src/system_media.rs`：Windows SMTC 集成（设置 AppUserModelID、媒体信息/时间线更新、媒体按键事件转发到前端）。
- `docs/`：设计文档（`lyrics-experience-plan.md`、`lyrics-motion-review.md`）与视觉证据截图（`docs/evidence/`）。`design-qa.md` 记录歌词模式的视觉 QA。
- `scripts/`：目前为空。

### 模块导入约定

`src/utils/` 中被 node 测试覆盖的模块之间互相引用时，相对导入必须带显式 `.js` 后缀（例如 `music.ts` 中 `from "./smartPlaylist.js"`、`from "../constants.js"`），因为测试直接运行 `tsconfig.test.json` 编译出的 ESM 产物。React 侧（`.tsx` 及 `App.tsx`）的导入不带后缀。向被测 util 新增跨模块导入时遵守带 `.js` 后缀的写法。

## 持久化

- 应用状态存于 `localStorage`，键为 `src/constants.ts` 的 `STORAGE_KEY`（`zone-player-state-v1`）。
- 曲库 schema 版本为 `LIBRARY_SCHEMA_VERSION`（当前 6）。
- 收藏是 id 为 `DEFAULT_PLAYLIST_ID`（`favorites`）的默认播放列表；读取播放列表状态时必须用 `normalizePlaylists`，让旧状态补齐默认收藏列表。
- home pins 用 `normalizeHomePins`/`reconcileHomePins` 做归一化与对账。
- 歌词缓存、手动绑定与按曲目保存的在线搜索信息映射在 `zone-local-lyrics-v1`；歌词 provider 设置在 `zone-lyrics-providers-v1`；按曲目与歌词来源保存的时间校准在 `zone-lyrics-timing-v1`。

## 播放与 Web Audio

可视化必须使用真实音频分析，播放音乐时不允许用空闲动画冒充。

关键约束：

- Tauri `convertFileSrc(path)` 默认走 `asset` 协议（通常是 `http://asset.localhost/...`）。
- dev 下页面源通常是 `http://localhost:5173`（vite 端口 5173，strictPort，host 127.0.0.1）。
- Web Audio 可以播放跨源媒体，但媒体响应缺少有效 CORS 头时 `createMediaElementSource` 输出全零。
- 应用使用自定义 Tauri 协议 `zone-audio` 播放音频：
  - `convertFileSrc(activeTrack.path, "zone-audio")`
  - 响应带 `Access-Control-Allow-Origin: *`、字节范围支持、正确的音频 content type
- 主 `<audio>` 保持 `crossOrigin="anonymous"`（`App.tsx` 中既有属性赋值也有 JSX 属性）。
- 除非有充分理由，不要再引入第二个隐藏的分析用 `<audio>`。目标音频图：

```text
audioRef -> MediaElementAudioSourceNode -> AnalyserNode -> GainNode -> destination
```

如果可视化看起来是假的或从不响应，先在 dev 控制台检查：

```text
MediaElementAudioSource outputs zeroes due to CORS access restrictions
```

## 正在播放的视觉方向

正在播放页应贴近 Zune 4.8：

- 背景：
  - 视觉层为 Canvas 实现（`NowPlayingMosaicCanvas` + `AudioGlowCanvas`，测试 `tests/nowPlayingCss.test.mjs` 断言其为 canvas 而非旧 SVG 分层）。
  - 用本地专辑/艺术家封面做拼贴，优先当前艺术家的专辑。
  - 从当前封面派生柔和色彩罩染；另有一盏「游动灯光」（`createMosaicColorSweep` 的径向光斑）沿非固定轨迹漂移，色相随位置变化，光斑对侧区域相应压暗。
  - 只做缓慢的平移/缩放，动效像呼吸而不是幻灯片；磁贴随机翻面稀少且缓慢。
- 入场：
  - 页面以 `now-stage-dissolve`（280ms 纯透明度溶解）进入，无位移/缩放。
  - 队列面板先淡入，拼贴墙磁贴逐片错峰显现（`mosaicTileRevealAmount`，整墙约 0.9s，非顺序），曲目卡最后（墙 reveal 后约 850ms）淡入——由 `animations-responsive.css` 的 `stage-entering` 编排。
- 排版：
  - 允许大号、部分裁切的幽灵文字。
  - 功能性文字保持可读且克制。
  - 应用内避免解释性 UI 文案。
- 控制：
  - 极简线性控制；无操作约 5 秒后 chrome 直接隐藏（`IDLE_CHROME_DELAY` 进入 `chrome-immersive`），只留下拼贴与歌曲信息，无中间虚化态。
  - 控制区不应主导页面。
- 可视化：
  - 应像底部低暗的红/橙色光晕或火焰（`audioGlow.ts` 的 Zune mountain frame），不是传统均衡器。
  - 外层 `.visualizer` 背景保持透明或极淡。
  - 避免规则滚动的正弦波，运动由低频/低中频能量与波形包络驱动。
- 歌词模式：
  - 与「正在播放」同一空间的第二状态，不是新页面；背景拼贴与歌曲信息保持连续。
  - 当前行是空间中心，相邻行随距离降低透明度、缩小并轻微模糊；逐词进度由 `requestAnimationFrame` 直接读音频时钟驱动。
  - 详细设计与动效审查见 `docs/lyrics-experience-plan.md` 与 `docs/lyrics-motion-review.md`。

## 已实现的用户体验

- `quickplay`、`collection`、`now playing`、`settings` 导航可用。
- 已添加的音乐目录会被递归监听；音频文件或目录结构变化后，前端防抖并串行刷新曲库。
- 专辑网格纵向滚动；选中专辑显示曲目列表而不是立即播放。
- 专辑悬停播放按钮有延迟且低调。
- 艺术家标签是 Zune 式浏览器：艺术家 → 专辑 → 歌曲。
- 右键系统菜单被抑制；应用文本默认不可选中。
- 自定义右键菜单支持：播放、添加到正在播放、添加到收藏、添加到自定义播放列表、固定到 quickplay、查看信息。
- 可创建手动播放列表与规则驱动的智能播放列表。
- 正在播放页的收藏按钮切换当前曲目在收藏列表中的状态。
- 歌词模式：本地（内嵌/sidecar/手动绑定）与在线歌词，支持逐行/逐词同步、音译、TTML 背景人声、长音细节、滚轮浏览、点按跳转、在线搜索信息映射、手动选词与 TTML/LRC 导出。
- Windows 系统媒体控制（SMTC）：媒体信息、时间线、媒体按键与收藏同步。

## 测试策略

- 测试全部在 `tests/*.test.mjs`，使用 `node:test` + `node:assert/strict`。
- 两类测试：
  - 纯逻辑测试：从 `.tmp/visualizer-tests/`（由 `tsconfig.test.json` 编译）导入 util 函数做行为断言。被编译的 util 清单维护在 `tsconfig.test.json` 的 `include` 中——新增被测 util 时要同步加入。
  - 源码/CSS 守卫测试：用 `readFileSync` 读取 `src/` 下的源码与 CSS，做字符串包含/排除断言（如 `localization.test.mjs`、`nowPlayingCss.test.mjs`、`settingsCss.test.mjs`）。修改 UI 结构、CSS 类名或文案时这些测试可能失败，需同步更新。
- Rust 单元测试在 `src-tauri/src/lib.rs` 的 `#[cfg(test)]` 模块中（`cargo test` 可运行）。
- 视觉/动效类改动同时参考 `docs/lyrics-motion-review.md` 的审查基线（Emil Kowalski 动效规范：动效有目的、时长 ≤300ms、可打断、transform/opacity、尊重减少动态效果）。

## 安全约束

- 在线歌词请求一律经 Rust 命令 `request_lyrics_provider` 中转，前端不直接 fetch：
  - URL 白名单校验（`validate_lyrics_provider_url`）：只允许已注册的 LRCLIB、AMLL TTML DB、网易云音乐和 QQ 音乐 HTTPS 主机与固定 API 路径，无端口、禁重定向；QQ 回退搜索的查询参数也逐项校验。新增 provider 必须同时注册允许规则。
  - 超时钳制在 1.5s–20s；响应体大小有上限（`LYRICS_PROVIDER_RESPONSE_LIMIT`）；仅对 502/503/504 重试一次。
- `zone-audio` 协议：对协议路径做百分号解码与路径校验，范围请求做上限钳制，避免任意文件读取与超大响应。
- `tauri.conf.json` 中 `csp: null` 且 `assetProtocol.scope: ["**"]`，改动配置时注意不要进一步扩大攻击面。
- Tauri capabilities（`src-tauri/capabilities/default.json`）只授予窗口控制与 `opener:default` 最小权限。

## 设计护栏

- 始终把 Zune 参照放在首位；偏好克制的纵深感，而不是现代玻璃拟态仪表盘。
- 主应用界面避免卡片堆砌的布局。
- 避免大块解释性文字；避免与音乐内容无关的装饰性渐变/光斑。
- 尽可能使用真实封面与媒体派生色。
- 文本不得以破损方式重叠或溢出控制区。
- 保持桌面媒体软件应有的键盘/鼠标交互预期。

## 交付前验证清单

- 运行 `npm run build`。
- 改了 Rust/Tauri 代码则在 `src-tauri` 运行 `cargo check`。
- 协议、Tauri 配置或发布路径敏感改动运行 `npx tauri build --no-bundle`。
- 改了被测 util 或 UI/CSS 结构时运行 `npm test`。
- 可视化改动需要在用户要求运行应用时通过 `npm run tauri:dev` 实测，因为纯浏览器 Vite 无法完整验证 Tauri 自定义协议行为。

## 其他说明

- `Cargo.lock` 在 `.gitignore` 中被忽略（该文件对本二进制项目选择了不提交）。
- `.tmp/` 是测试编译产物目录，已被 gitignore，不要手改。
- 仓库中的文档（`docs/`、`design-qa.md`）与界面文案使用中文；代码注释使用英文。修改 `AGENTS.md` 中提到的结构、命令或约定时，请同步更新本文件。
