# Zone 项目说明

本文档面向 AI 编码代理，假设读者对本项目一无所知。请遵循其中的真实项目约定（构建命令、目录结构、测试方式），它与用户对话中的直接指令不冲突时均应遵守。

## 项目概览

Zone 是一个受 Microsoft Zune 4.8 启发的本地音乐播放器，技术栈为 Tauri 2 + React 18 + TypeScript + Vite。首要目标是打磨本地音乐播放体验，UI/UX 贴近 Zune，而不是做成一个普通的桌面播放器。

产品侧重要点：

- 本地音乐播放优先。支持格式：`mp3`、`flac`、`m4a`、`aac`、`wav`、`ogg`（见 `src-tauri/src/library.rs` 的 `is_supported_audio`）。
- Zune 风格的收藏导航：专辑、艺术家、歌曲、播放列表。
- Zune 风格的 quickplay 首页：固定（pin）的曲目/专辑/艺术家/播放列表磁贴。
- 正式播客体验：默认以“收听 / 发现 / 资料库 / 播放列表”组织内容，使用 Apple 中国区热门榜、公开 RSS 与安全流式播放；搜索和手动 RSS 是辅助入口，下载只用于离线收听。单集详情、稍后听、待播队列、倍速与睡眠定时均使用播客独立状态，不进入本地音乐的队列、收藏或播放统计。
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
  - `reqwest`（rustls）：在线歌词、播客目录/RSS 与音频流式代理/下载请求（均经 Rust 端中转，见下文安全约束）。
  - `feed-rs`：RSS/Atom 播客订阅源解析。
  - `rusqlite`（bundled SQLite）+ `sha2`：播客订阅、单集、下载与播放进度持久化及稳定标识。
  - `notify`：递归监听已添加的音乐目录，驱动防抖后的曲库自动刷新。
  - `windows` 0.61（仅 Windows）：系统媒体传输控制（SMTC）集成。

## 构建与测试命令

- `npm run build`：`tsc && vite build`，前端类型检查加构建。
- `npm test`（等同 `npm run test:visualizer`）：先用 `tsconfig.test.json` 把选定的 `src/utils/*.ts` 编译到 `.tmp/visualizer-tests/`，再执行 `node --test tests/*.test.mjs`。
- `cargo check`：在 `src-tauri/` 目录内运行，Rust 改动后必跑。
- `npx tauri build --no-bundle`：协议、Tauri 配置或发布路径敏感改动后运行。
- `npm run dev` / `npm run tauri:dev`：见下方运行策略，不要自动启动。

## 打包与发布

- `npm run tauri:build`：产出标准 NSIS + MSI 安装器（当前用户安装、中英双语、WebView2 在线引导）。
- `npm run tauri:build:store`：叠加 `src-tauri/tauri.microsoftstore.conf.json`（WebView2 改为 offlineInstaller），产出商店路线 A 的自包含安装器；与普通 NSIS 输出同名会互相覆盖。
- `npm run package:msix`：经 `packaging/build-msix.ps1`（需 winapp CLI）产出商店路线 B / 旁加载用 MSIX；版本按 tauri.conf.json 三段转四段盖章，只改 staging 副本。
- 图标唯一事实源是仓库根 `app-icon.png`；改动后 `npx tauri icon` 重新生成 `src-tauri/icons/`。MSIX 资产在 `packaging/Assets/`。
- 商店上架流程、Identity 回填与签名约定见 `packaging/README.md`。

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

- `src/App.tsx`：应用组合根（约 800 行）。持有唯一的 `<audio ref={audioRef}>` 与跨 hook 共享状态（queue/activeTrackId/playHistory/selectedPlaylistId、浮层与 actionNotice、playbackSessionRef 及三个 late-bound ref），按序调用 `useNavigation` → `useMusicLibrary` → `usePodcastPlayback` → `usePlaybackControls` → `useAudioEngine` → `usePlaylists`，负责 localStorage 状态恢复/持久化、卸载清理、`useSystemMedia` 接线与全部 JSX。共享 ref/state 只在 App 层或拥有它的 hook 创建一次，经参数传递；hook 间反向调用经渲染期赋值的 late-bound ref 保持单向传参（播客 → `playbackControlsRef` 的 arm/seek/toggle/intent；播放控制 → `audioEngineRef`；`openNowPlaying` 的媒体目标）。
- `src/app/podcastPlaybackSettings.ts`：播客倍速/活动单集/自动续播偏好（`zone-podcast-playback-v1`）的常量、类型与 read/patch 纯函数，附 `webkitAudioContext` 全局声明。
- `src/hooks/`（应用组合 hook，由 App 按上述顺序调用）：
  - `useNavigation.ts`：page/view/搜索状态、`requestNavigation` 页面过渡、搜索导航与 Ctrl/Cmd+F/Esc 键盘 effect、`openNowPlaying`。
  - `useMusicLibrary.ts`：folders/tracks/scan/trackActivity 状态、元数据重扫、trackActivity 迁移、albums/artists 分组与专辑选中、addFolder/rescan 与 `useLibraryWatcher` 接线。
  - `usePodcastPlayback.ts`：播客会话/队列/进度 domain。对外只返回产品状态与动作（无 ref、无裸 setter），另附 `transport: PodcastTransportBridge` 给播放控制；拥有播客自然结束处理 `handleEpisodeEnded` 与待播消费判定（经 `playbackControlsRef` 的 `hasEpisodeStartedOnDevice` 回查 transport 事实）。
  - `podcastTransport.ts`：`PodcastTransportBridge` 窄接口：零 ref，仅只读值（`activePodcastEpisode`/`podcastPlaybackRate`/`podcastSessionHydrated`）+ 语义方法（`consumePendingPodcastQueueEpisode(episodeId, audioEpisodeId)`、`cancelPendingQueueConsume`、`handleEpisodeEnded` 等）；唯一保留的裸 setter 是 `setPodcastPlaybackStatus`（controls 的 transport 状态上报）。
  - `usePlaybackControls.ts`：拥有 `audioPlayAttemptRef`（唯一递增点在 `beginPlayAttempt`）、autoplay intent、pending start/resume、`podcastAudioEpisodeRef`/`podcastPlaybackStartedEpisodeRef` 等全部 transport ref；`runPlayAttempt` 为唯一 `audio.play()` 成功/失败门闩；音乐 queue/shuffle/repeat/统计、媒体源切换与 audio 事件；onEnded 播客分支委托 `handleEpisodeEnded`；transport 守卫/解析统一走 `src/utils/playbackTransport.ts` 纯函数（`tests/playbackTransport.test.mjs` 行为覆盖）。
  - `useAudioEngine.ts`：Web Audio 图 refs、ensureAudioGraph/resumeAudioGraph、节拍预分析、可视化采样循环与启停、音量应用；以 `AudioEngineHandle` 形式经 ref 交给播放控制。
  - `usePlaylists.ts`：playlists/homePins/收藏状态与 CRUD、homePins 对账、toggleHomePin/openHomePin。
- `src/types.ts`：所有共享类型定义（Track、Playlist/SmartPlaylist、HomePin、PodcastFeed/Episode、LyricsDocument/LyricsProvider 等）。`AppPage = "quickplay" | "collection" | "podcasts" | "nowPlaying" | "settings"`。
- `src/constants.ts`：`STORAGE_KEY = "zone-player-state-v1"`、`LIBRARY_SCHEMA_VERSION = 6`、`DEFAULT_PLAYLIST_ID = "favorites"`、`MAX_HOME_PINS = 12`、`VISUALIZER_SAMPLE_COUNT = 180`。
- `src/views/`：页面级视图。
  - `QuickplayView.tsx`：Zune quickplay 首页，可固定/排序磁贴。
  - `LibraryView.tsx`：收藏页标签切换（专辑/艺术家/歌曲/播放列表），保持轻薄并向下委托。
  - `ArtistBrowser.tsx`：Zune 风格艺术家导航（艺术家 → 专辑 → 歌曲）。
  - `PlaylistBrowser.tsx`：当前队列与已存播放列表（含智能播放列表）。
  - `PodcastView.tsx`：正式播客页壳（约 230 行）。负责分区 chrome、六屏切换与浮层（菜单/确认框）；业务状态与数据加载在 `usePodcastViewModel`，各屏 JSX 在 `screens/*`。默认“收听”聚合继续收听与关注更新；“发现”承载榜单、搜索与辅助 RSS；“资料库”展示已关注、稍后听和已下载；节目/单集详情支持关注、保存、播放状态、即时播放、待播与离线下载；“播放列表”管理当前单集与持久待播队列。
  - `src/views/podcast/`：播客视图模块。`usePodcastViewModel.ts` 持有 screen 状态机、缓存读写与 invoke 编排；`api.ts` 为全部 `podcast_*` 命令的薄封装（屏组件不得直接 `invoke`）；`screens/`（Listen/Discover/Library/Playlist/Show/Episode）为展示层；另有 `types.ts`/`constants.ts`/`cache.ts`（模块级缓存单例，不可拆散）/`episodeModel.ts`/`preferences.ts`/`format.ts` 与 `components/`（EpisodeRows、QueueEpisodeRow、EpisodeDetail、ContinueCard、ShowCards、Dialogs、primitives）。
  - `PodcastNowPlayingView.tsx`：播客专属全屏正在播放。提供 15/30 秒跳转、0.5–3× 倍速、睡眠定时、音量、简介、保存、缓冲/错误反馈与待播管理，不复用音乐 `NowPlayingView` 的拼贴和歌词内部状态。
  - `NowPlayingView.tsx`：全屏正在播放。Canvas 封面拼贴背景、队列浮层、曲目卡片、收藏按钮、进度/走带控制、歌词模式切换。
  - `SettingsView.tsx`：音乐文件夹管理与在线歌词来源（provider）启用/优先级设置。
- `src/components/`：可复用 UI。包括 `Cover`（唯一封面渲染入口：`artPath` 本地文件或 `src` 已解析 URL，`className`/`fallback` 供播客等上下文适配）、`Button`（动作按钮原语，样式在 `styles/controls.css`，variant/size/`busy` 内嵌 MetroLoader）、`Dialog`（深色确认/表单对话框壳，播客确认框共用；SmartPlaylistDialog 编辑器与正在播放浅色保存框为例外）、`tiles/`（Metro 磁贴系统：`Tile`/`FlipTile`/`CycleTile`/`IconicTile`/`MosaicFrames`，样式在 `styles/tiles.css`，quickplay 固定项在用 FlipTile+MosaicFrames，Cycle/Iconic 为备料模板）、`PlayerBar`、`PodcastPlayerBar`、`TransportControls`、`PlaybackProgress`、`ContextMenu`、`InfoPanel`、`Titlebar`、`EmptyState`、`PlaylistDialog`、`SmartPlaylistDialog`、`MetroLoader`（全局 Metro 五点绕圈加载原语，样式在 `styles/base.css` 的 `.metro-loader`/`metro-orbit`，`size`/`large` 控制尺寸，reduced-motion 在 `motion.css` 统一收敛）、`LyricsStage`（歌词舞台主组件；纯 helper 在 `lyricsStage/lyricsLineUtils.ts`，rAF 逐词绘制在 `lyricsStage/useLyricsPaintLoop.ts`，在线搜索与设置面板分别在 `lyricsStage/LyricsSourceBrowser.tsx`/`LyricsSettingsPanel.tsx`）、`NowPlayingMosaicCanvas` 与 `AudioGlowCanvas`（正在播放的两个 Canvas 视觉层）。
- `src/hooks/`（独立功能 hook）：
  - `useLibraryWatcher.ts`：配置 Rust 目录监听、接收文件变化事件并在 800ms 防抖后触发曲库刷新。
  - `useLyrics.ts`：歌词加载/缓存/在线搜索状态机（本地缓存键 `zone-local-lyrics-v1`）。
  - `useLyricsDisplaySettings.ts`：歌词翻译/音译/背景人声显隐与字号偏好（键 `zone-lyrics-display-v1`）。
  - `useLyricsProviderSettings.ts`：歌词 provider 启用与优先级（键 `zone-lyrics-providers-v1`）。
  - `useSystemMedia.ts`：与 Rust 端 SMTC 集成（`update_system_media*` 命令与媒体按键事件）。
- `src/lyrics/providers.ts`：AMLL TTML DB、QQ 音乐、网易云音乐、LRCLIB 四个在线歌词 provider 的定义与编排。自动查找按优先级回退并在高置信命中后停止；手动在线搜索并行查询全部已启用来源。请求统一经 Rust 命令 `request_lyrics_provider` 中转。
- `src/utils/`：纯逻辑模块（详见各测试）。
  - `music.ts`：专辑分组、曲目排序、播放列表默认值、`normalizePlaylists`。
  - `podcastArtwork.ts` / `podcastPlayback.ts`：播客代理封面 URL、播放模型归一化、实时播放状态覆盖和待播顺序移动。
  - `playback.ts`：队列移动/随机顺序/边界解析。
  - `smartPlaylist.ts`：智能播放列表规则求值与归一化。
  - `homePins.ts`：quickplay 固定项的归一化、移动、对账。
  - `visualizer.ts` / `beatAnalysis.ts` / `audioGlow.ts` / `nowPlayingWall.ts` / `nowPlayingCanvas.ts`：音频帧、节拍网格、Zune 光焰与封面拼贴的纯计算部分。
  - `visualizerBus.ts`：可视化帧的单槽 latest-frame 总线（`publishVisualizerFrame` / `getVisualizerFrame`）。App 采样循环每帧发布一次，正在播放页两个 Canvas 在各自常驻 rAF 中拉取，不经 React state/props。
  - `lyrics.ts` / `amllTtml.ts` / `qrc.ts`：plain、LRC、增强 LRC、TTML、AMLL 元数据和 QQ QRC 的解析与归一化。
  - `lyricsProviders.ts` / `lyricsProviderSearch.ts` / `lyricsSearch.ts`：候选打分与多样性裁剪、多来源搜索策略、按曲目保存的搜索信息修正。
  - `lyricsTiming.ts` / `lyricsExport.ts` / `lyricsMotion.ts`：时间校准、TTML/LRC 导出与真实逐词时间驱动的长音包络。
  - `demoLyrics.ts`：仅动效原型用的演示歌词。
- `src/motion/`：自研动效内核（完整说明见 `design/motion-system.md`）。
  - `tokens.ts`：动效 token 唯一事实源（时长/缓动/幅度/弹簧预设），`applyMotionTokens()` 启动时注入 `:root` CSS 变量，CSS 只消费不定义。
  - `math.ts` / `spring.ts` / `tween.ts` / `animate.ts`：共享数学、半隐式欧拉弹簧、缓动求值与共享 rAF 动画器（`animateValue`，可 retarget 惯性接力）。
  - `flip.ts` / `coverFlip.ts`：FLIP registry 与封面共享元素飞行编排（播放条 ↔ 正在播放曲目卡，`cover:{trackId}`）。
  - `presence.tsx`：`<Presence>` 浮层退场存在组件与 `useLastNonNull`。
  - `pageTransition.ts`：页面切换编排表（pivot/push/pop），由 App 的 `requestNavigation` 消费。
  - `useReducedMotion.ts`：reduced-motion 统一 hook。
- `src/styles.css`：按序 `@import` `src/styles/` 下的拆分 CSS：`base`、`controls`（Button 原语变体与尺寸）、`collection`、`podcasts`、`podcast-now-playing`、`quickplay`、`player`、`now-playing`、`lyrics`、`overlays-settings`、`playlists`、`tiles`（Metro 磁贴系统）、`motion`（动效原语层：feather 入场、页面/浮层出入场、反馈动画、共享 `.tilt-pressed` 倾斜规则、唯一 reduced-motion 块）、`animations-responsive`（正在播放入场编排与响应式）。
- `src-tauri/src/lib.rs`（约 130 行）：应用初始化接线。只保留 `update_system_media`/`update_system_media_timeline` 两个薄命令与 `pub fn run()`（协议注册、setup、`generate_handler!`）；其余命令按模块以 `library::scan_library` 等前缀形式注册。
- `src-tauri/src/library.rs`：曲库扫描与目录监听。命令 `select_music_folder`、`scan_library`、`watch_music_folders`；`LibraryWatcherState`、`MusicFolder`/`Track`/`ScanResult`/`LibraryFilesChanged`、`is_supported_audio`、`track_from_path`、封面提取与缓存（内嵌封面写入缓存目录）、GBK 乱码修复族、`stable_track_id`。
- `src-tauri/src/lyrics.rs`：本地歌词。命令 `select_lyrics_file`、`export_lyrics_file`（`LYRICS_EXPORT_CONTENT_LIMIT` + 保存对话框写文件）、`load_local_lyrics`；内嵌标签歌词、同目录 sidecar 歌词（`.ttml` → `.lrc` → `.txt`，文件名和扩展名大小写不敏感）、UTF-16/GBK 解码修复。
- `src-tauri/src/lyrics_provider.rs`：在线歌词中转。命令 `request_lyrics_provider`（白名单校验、超时钳制、响应上限、网关重试）与 `decrypt_qrc_lyrics`，以及全部 provider URL/请求体校验 helper。
- `src-tauri/src/audio_protocol.rs`：`zone-audio` 自定义协议（`serve_audio_protocol`）：CORS 安全的本地音频播放与 Web Audio 分析，含字节范围（`Accept-Ranges`/`Content-Range`）与正确的音频 content type。
- 上述 Rust 模块各自内带 `#[cfg(test)]` 单元测试。
- `src-tauri/src/podcast/`：播客目录模块（对外路径保持 `podcast::xxx`，由 `mod.rs` re-export）。`mod.rs` 持有 `PodcastState`、跨模块共享常量与 re-export；`types.rs` 为全部 pub DTO；`util.rs` 通用小工具与 ISO8601 历法解析；`network.rs` 公共 URL/DNS/重定向 SSRF 校验、限流读取与响应工具；`apple.rs` Apple 中国区热门榜与搜索；`feed_parse.rs` 20 MiB RSS 限流拉取、字节修复、命名空间解析与归一化；`store.rs` SQLite schema/迁移与订阅/刷新写入；`query.rs` 查询侧与稍后听/已播；`chapters.rs` 单集详情与章节；`queue.rs` 待播队列；`downloads.rs` 受控目录下载/续传/删除、进度保存与文件守卫；`stream_protocol.rs` `zone-podcast` 分块 Range 代理与音频魔数识别；`artwork_protocol.rs` `zone-podcast-artwork` 限流图片代理；`commands.rs` 29 个 `#[tauri::command]` 薄壳；测试按被测代码归属下沉到各文件末尾的 `#[cfg(test)] mod tests`（共享 fixture 在 `test_support.rs`），真实网络 smoke 仍仅在 `ZONE_PODCAST_LIVE=1` 后运行。
- `src-tauri/src/qrc.rs`：有边界限制的 QQ QRC 解密/解压实现；解密后的逐词时间轴由前端 `src/utils/qrc.ts` 转换为统一 TTML 再进入通用解析器。
- `src-tauri/src/system_media/`：Windows SMTC 集成（`mod.rs` 为跨平台入口，`windows_impl/` 为 Windows 实现：设置 AppUserModelID、媒体信息/时间线更新、媒体按键事件转发到前端）。
- `docs/`：探索性设计文档（`lyrics-experience-plan.md`、`lyrics-motion-review.md`）与视觉证据截图（`docs/evidence/`），整个目录为本地未跟踪。`docs/design-qa.md` 记录歌词模式的视觉 QA。
- `design/`：约束性规范，纳入 git 管理（`motion-system.md` 动效系统说明书、`component-guidelines.md` 组件与设计规范）。新组件/动效先对照 `design/component-guidelines.md`。
- `scripts/`：一次性重构 codemod（PodcastView 拆分时使用的提取/接线/测试路径迁移脚本），仅作历史留档，不在构建链路中。

### 模块导入约定

`src/utils/` 与 `src/motion/` 中被 node 测试覆盖的模块之间互相引用时，相对导入必须带显式 `.js` 后缀（例如 `music.ts` 中 `from "./smartPlaylist.js"`、`nowPlayingCanvas.ts` 中 `from "../motion/math.js"`），因为测试直接运行 `tsconfig.test.json` 编译出的 ESM 产物。React 侧（`.tsx` 及 `App.tsx`）的导入不带后缀。向被测模块新增跨模块导入时遵守带 `.js` 后缀的写法。

## 歌词子系统基线

歌词功能已经进入可用阶段。后续修改应建立在现有链路上，不要另起一套搜索、缓存、解析或播放时钟。

### 统一数据模型与来源顺序

- 所有来源最终归一化为 `LyricsDocument`：`format` 为 `plain`、`line` 或 `word`；行可包含翻译、音译、逐词时间和带独立时间轴的背景人声。
- 音译是原文的罗马字/读音辅助（TTML `x-roman`），不是翻译；背景人声是 TTML `x-bg` 提供的独立演唱轨，不从普通文本猜测生成。
- 已手动选定的在线候选或本地文件是按曲目保存的显式覆盖，二者互斥；清除覆盖后恢复自动发现。
- 没有显式覆盖时，自动顺序为：音频标签内嵌歌词 → 同名 sidecar（`.ttml` → `.lrc` → `.txt`）→ 在线自动搜索。现有实现让内嵌歌词优先于 sidecar，不要在无产品决策时悄悄交换。
- `src/utils/demoLyrics.ts` 只在开发环境中作为动效预览兜底；生产环境无歌词时显示 missing/error，演示歌词禁止导出或写入正式缓存。
- 解析结果缓存会校验 parser version、`sourceId`、源文件修改时间和曲目时长。改变解析语义时应递增 `LYRICS_PARSER_VERSION`，避免继续读取旧文档。

### 在线 Provider 与搜索语义

四个来源默认均启用，用户可在设置中启用/停用和调整顺序：

| 默认顺序 | Provider ID | 能力 | 默认超时 |
| --- | --- | --- | --- |
| 5 | `amll-ttml-db` | 逐词、翻译、音译，以及 TTML 中的背景人声 | 15 秒 |
| 10 | `qq` | QRC 逐词、翻译 | 8 秒 |
| 20 | `netease` | 逐行、翻译 | 8 秒 |
| 30 | `lrclib` | 逐行或纯文本 | 15 秒 |

- 自动搜索使用 `priority-fallback`：按用户优先级串行查询，某个来源出现分数不低于 `DEFAULT_LYRICS_MATCH_THRESHOLD`（当前 72）的有效候选后停止，不让弱匹配自动替换正确歌词。
- 手动“在线搜索”使用 `all`：同时查询全部已启用来源；单个来源超时、报错或无结果不能吞掉其他来源的候选。结果先保证每个有结果的 Provider 至少保留一个，再按匹配度补齐（当前最多 24 个）。
- 候选匹配综合标题、艺术家、专辑和时长；常见版本/发行后缀会在比较前归一化。Provider 优先级只用于同等匹配的排序，不应压过明显更准确的候选。
- 搜索面板会显示每个 Provider 的 `ready` / `empty` / `error` 结果和候选数量。修改搜索编排时要保留这些 outcome，不能只返回合并后的单一结果。
- 用户可以只为歌词搜索修正标题、艺术家和专辑；修正值按曲目持久化，不改写本地音频标签。查询信息或 Provider 配置变化后，旧远程缓存不得被当作当前查询结果。
- 开发环境前端使用 `[lyrics]` 控制台日志；Rust 中转使用 `[lyrics:<request_id>]` 输出请求开始、响应头、完成、重试或错误信息。通过 `npm run tauri:dev` 可同时观察前后端诊断，但仍只在用户明确要求时启动。

### 同步、动效与交互

- 歌词顶栏只保留当前来源与“歌词设置”入口；显示、同步、来源和导出统一收进可扩展的右侧设置面板。设置面板与在线来源搜索都必须使用 `Presence` 保留退场，不要重新把功能平铺回歌词舞台。
- `LyricsStage` 的逐词填充由 `requestAnimationFrame` 直接读取真实媒体时钟，并通过 DOM/CSS 变量更新；不要用 React state 做逐帧进度，以免重新引入卡顿。
- 当前行居中，相邻行按距离降低透明度、缩小和轻微模糊；滚轮进入临时浏览态，约 3 秒后回到播放行，点击歌词行需按同一时间映射跳转。
- 长音细节只由真实逐词起止时间计算，普通短词不触发；进入手动浏览或 `prefers-reduced-motion` 时应收敛或关闭。
- 时间校准按 `trackId + sourceId` 保存，步进 250ms、范围 ±5 秒；正值表示歌词延后。逐词填充、行聚焦和点按跳转必须共同使用 `lyricsTiming.ts` 的可逆映射，避免显示与 seek 采用两套符号约定。

### 导出与持久化边界

- TTML 是保真导出：保留逐词时间、翻译、音译、背景人声和当前校准。
- LRC 导出优先兼容性：逐词文档输出增强 LRC，保留逐词起点与翻译；音译和背景人声无法无歧义表达时不写入。界面必须继续明确这一损失边界。
- 导出时会把当前校准烘焙进时间戳；写文件只经 Rust `export_lyrics_file` 的保存对话框完成，不在前端直接写路径。
- `zone-local-lyrics-v1` 保存本地/在线手动绑定、解析缓存、远程候选缓存和按曲目搜索信息；`zone-lyrics-display-v1` 保存显示偏好；`zone-lyrics-providers-v1` 保存 Provider 开关与优先级；`zone-lyrics-timing-v1` 保存每首曲目、每个来源的校准。迁移或清理任一存储时不能误删其他类别的状态。

### 修改歌词功能时的最低验证

- 解析、评分、搜索编排、校准、导出或长音逻辑变化：运行 `npm test`，并更新对应的 `tests/lyrics*.test.mjs` 或 `tests/qrc.test.mjs`。
- Provider URL、请求体、响应上限、QRC 解密或 Rust 文件读写变化：除 `npm test` 外，在 `src-tauri/` 运行 `cargo check`；改白名单时同步补 Rust 测试。
- 歌词舞台结构或动效变化：运行 `npm run build` 和 `npm test`，并按 `docs/lyrics-motion-review.md` 检查真实播放、手动浏览、点击跳转、减少动态效果和窄窗口布局。

## 持久化

- 应用状态存于 `localStorage`，键为 `src/constants.ts` 的 `STORAGE_KEY`（`zone-player-state-v1`）。
- 曲库 schema 版本为 `LIBRARY_SCHEMA_VERSION`（当前 6）。
- 收藏是 id 为 `DEFAULT_PLAYLIST_ID`（`favorites`）的默认播放列表；读取播放列表状态时必须用 `normalizePlaylists`，让旧状态补齐默认收藏列表。
- home pins 用 `normalizeHomePins`/`reconcileHomePins` 做归一化与对账。
- 歌词缓存、手动绑定与按曲目保存的在线搜索信息映射在 `zone-local-lyrics-v1`；歌词显示偏好在 `zone-lyrics-display-v1`；歌词 provider 设置在 `zone-lyrics-providers-v1`；按曲目与歌词来源保存的时间校准在 `zone-lyrics-timing-v1`。
- 播客状态不写入音乐 `localStorage` schema；节目预览/关注状态、单集、稍后听、待播顺序、下载与进度存于应用数据目录的 `podcasts.sqlite`，音频位于同目录下的 `podcast-downloads/`。预览节目可以入库但不出现在资料库，`subscribed` 只表达用户是否关注。Feed 刷新时若单集已从源消失，仅在无进度、未稍后听、未排队、无进行中/完成下载时删除该行；有用户状态的单集会保留。`enclosure_url` 变更会失效对应离线下载。普通进度写仅允许前进，显式 seek/flush 传 `force` 才可回退。播客播放倍速与最后一个活动单集 ID 独立保存在 `zone-podcast-playback-v1`，最后单集重启后以暂停态恢复且不改变音乐播放速度；睡眠定时只存在于当前运行会话。

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

- 未下载播客经 `zone-podcast`、已下载播客经 `zone-audio`，二者都复用主 `<audio>`；播客不得进入音乐 queue、收藏或播放统计，也不得触发音乐的整文件节拍预分析。

如果可视化看起来是假的或从不响应，先在 dev 控制台检查：

```text
MediaElementAudioSource outputs zeroes due to CORS access restrictions
```

## 正在播放的视觉方向

正在播放页应贴近 Zune 4.8：

- 背景：
  - 视觉层为 Canvas 实现（`NowPlayingMosaicCanvas` + `AudioGlowCanvas`，测试 `tests/nowPlayingCss.test.mjs` 断言其为 canvas 而非旧 SVG 分层）。
  - 用本地专辑/艺术家封面做拼贴，优先当前艺术家的专辑。
  - 从当前封面派生柔和色彩罩染；另有动态色彩场（`createMosaicColorFieldSampler`，`globalCompositeOperation = "color"`）沿多角度慢变轨迹漂移，色相随位置变化。
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

## 动效系统

动效系统已统一为自研内核 + CSS 原语层，完整说明书见 `design/motion-system.md`（原则、token 表、内核 API、新组件接入指南）。核心约定：

- 六条原则：短（≤260ms）、物理感（惯性/减速、可打断接力）、页面间延续、内容分级幅度（`--motion-drift-s/m/l`）、服务内容、目的明确（反馈/引导/解释关系）。
- token 唯一事实源是 `src/motion/tokens.ts`，启动时注入 CSS 变量；CSS 与 TS 都不得硬编码时长/缓动。
- 页面导航走 `requestNavigation`（退场 160ms + 方向感 + 可打断），不要裸 `setPage`。
- 浮层入场用 `@starting-style`，退场用 `<Presence>` + `motion.css` 的 `.motion-exit` 后代规则；不允许「状态置 null 立即消失」。
- 逐帧动画用 `animateValue` 弹簧/补间并直写 DOM，禁止 React state 驱动逐帧进度；每帧可视化数据走 `visualizerBus.ts`。
- 共享元素连续用 FLIP（`flip.ts` + `coverFlip.ts` 模式），两侧都要 `useReducedMotion()` gate。
- reduced-motion 只有 `motion.css` 末尾一个媒体查询块，新组件动效要同步补进清单。

## 已实现的用户体验

- `quickplay`、`collection`、`podcasts`、`now playing`、`settings` 导航可用。
- 已添加的音乐目录会被递归监听；音频文件或目录结构变化后，前端防抖并串行刷新曲库。
- 专辑网格纵向滚动；选中专辑显示曲目列表而不是立即播放。
- 专辑悬停播放按钮有延迟且低调。
- 艺术家标签是 Zune 式浏览器：艺术家 → 专辑 → 歌曲。
- 右键系统菜单被抑制；应用文本默认不可选中。
- 自定义右键菜单支持：播放、添加到正在播放、添加到收藏、添加到自定义播放列表、固定到 quickplay、查看信息。
- 可创建手动播放列表与规则驱动的智能播放列表。
- 正在播放页的收藏按钮切换当前曲目在收藏列表中的状态。
- 歌词模式：本地（内嵌/sidecar/手动绑定）与在线歌词，支持逐行/逐词同步、音译、TTML 背景人声、长音细节、滚轮浏览、点按跳转、在线搜索信息映射、手动选词与 TTML/LRC 导出。
- 统一动效系统：页面 pivot/push/pop 成对过渡、浮层成对出入场、封面在播放条与正在播放页之间 FLIP 飞行、feather 错峰入场、reduced-motion 统一收敛（见 `design/motion-system.md`）。
- Windows 系统媒体控制（SMTC）：媒体信息、时间线、媒体按键与收藏同步。
- 播客正式链路：默认页直接展示继续收听、关注更新与 Apple 中国区热门节目；发现结果可先预览再关注，关注、稍后听与下载状态相互独立。未下载单集通过受控 `zone-podcast` Range 代理即时播放，已下载单集通过 `zone-audio` 本地播放，进度每 5 秒节流且按调用顺序保存；使用独立播客底栏、全屏正在播放和可跨重启恢复的当前单集与待播队列。待播项只在对应音源实际开始播放后消费；单集自然结束会进入待播首项，睡眠定时可在指定分钟或本集结束后暂停。

## 测试策略

- 测试全部在 `tests/*.test.mjs`，使用 `node:test` + `node:assert/strict`。
- 两类测试：
  - 纯逻辑测试：从 `.tmp/visualizer-tests/`（由 `tsconfig.test.json` 编译）导入 util 函数做行为断言。被编译的 util 清单维护在 `tsconfig.test.json` 的 `include` 中——新增被测 util 时要同步加入。
  - 源码/CSS 守卫测试：用 `readFileSync` 读取 `src/` 下的源码与 CSS，做字符串包含/排除断言（如 `localization.test.mjs`、`nowPlayingCss.test.mjs`、`settingsCss.test.mjs`）。修改 UI 结构、CSS 类名或文案时这些测试可能失败，需同步更新。
- Rust 单元测试在 `src-tauri/src/`（`library.rs`、`lyrics.rs`、`lyrics_provider.rs`、`audio_protocol.rs`、`podcast/` 目录各模块）各模块的 `#[cfg(test)]` 模块中（`cargo test --lib` 可运行）。真实播客网络 smoke 默认忽略，仅在显式设置 `ZONE_PODCAST_LIVE=1` 后运行。
- 播客前后端接线、安全代理、单集详情、待播和独立播放边界由 `tests/podcast.test.mjs` 与 `tests/podcastPlayback.test.mjs` 守卫；修改播客模型、命令或播放分支时运行 `npm test`，修改 Rust 数据库/协议/下载逻辑时同时运行 `cargo check`。
- 动效内核（`src/motion/`）的行为测试在 `tests/motion.test.mjs`；封面 FLIP 接线守卫在 `tests/coverFlip.test.mjs`，其运行时行为回归（手写 DOM mock + 假动画时钟）在 `tests/coverFlipBehavior.test.mjs`；可视化总线在 `tests/visualizerBus.test.mjs`。动效系统的原则与接入约定见 `design/motion-system.md`。
- 视觉/动效类改动同时参考 `docs/lyrics-motion-review.md` 的审查基线（Emil Kowalski 动效规范：动效有目的、时长 ≤300ms、可打断、transform/opacity、尊重减少动态效果）。

## 安全约束

- 在线歌词请求一律经 Rust 命令 `request_lyrics_provider` 中转，前端不直接 fetch：
  - URL 白名单校验（`validate_lyrics_provider_url`）：只允许已注册的 LRCLIB、AMLL TTML DB、网易云音乐和 QQ 音乐 HTTPS 主机与固定 API 路径，无端口、禁重定向；QQ 回退搜索的查询参数也逐项校验。新增 provider 必须同时注册允许规则。
  - 超时钳制在 1.5s–20s；响应体大小有上限（`LYRICS_PROVIDER_RESPONSE_LIMIT`）；仅对 502/503/504 重试一次。
- 播客网络请求由 `src-tauri/src/podcast/`（`network.rs` 与 `apple.rs`）专用客户端处理：Apple 搜索固定 `country=CN`；RSS/音频只允许 HTTP(S)，每次重定向重新校验并固定解析地址，拒绝凭据、fragment、非 80/443 端口与内网/环回 IP。为兼容大陆常见 Clash fake-IP，仅允许“域名解析所得”的 `198.18.0.0/15`，直接输入该网段仍被拒绝。
- RSS 响应上限 20 MiB，音频上限 2 GiB；下载目标只按数据库中的 episode ID 生成，先写 `.part` 并支持 Range 续传，通过音频魔数后再原子落盘。
- 删除播客下载只允许清理由数据库 episode ID 推导且位于受控下载目录中的最终文件与精确 `.part`；下载和删除对同一单集互斥，不能让前端传入任意文件路径。
- `zone-podcast` 协议只接受数据库中的 64 位 episode ID，绝不接受前端传入的远程 URL；每个 Range 响应最多代理 1 MiB，带 CORS，逐跳应用相同 SSRF 校验。上游不支持 Range 且内容超过单块上限时明确失败，由用户选择离线下载。
- RSS 与目录返回的远程封面不得直接作为 WebView 的 `<img src>`；统一先编码为 URL-safe token，再经 `zone-podcast-artwork` 代理。代理逐跳校验 DNS/重定向，限制 8 MiB，只接受受支持的图片 MIME 与匹配的文件魔数。
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
- 仓库中的文档（`docs/`，本地未跟踪）与界面文案使用中文；代码注释使用英文。修改 `AGENTS.md` 中提到的结构、命令或约定时，请同步更新本文件。
