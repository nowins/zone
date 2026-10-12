# 代码导航与当前架构

本文由根目录 [AGENTS.md](../../AGENTS.md) 按任务索引引用。文中的行为与安全边界适用于相关改动；标为当前实现的参数用于定位，可在验证后调整。代码路径均相对于仓库根目录。

本文是定位地图，不是冻结目录、行数或依赖版本的约束。依赖版本以 `package.json` / `src-tauri/Cargo.toml` 为准，具体导出与命令以源码为准；修改模块职责后同步相应条目。

## 技术栈

- 前端：React 18、TypeScript（strict）、Vite（`@vitejs/plugin-react`）、`lucide-react` 图标、`@tauri-apps/api`。构建和测试使用 Node.js 24 LTS 或更新版本；版本以依赖清单为准。
- 桌面壳：Tauri 2。窗口 1180×760（最小 920×620），无边框（`decorations: false`），自带 `Titlebar` 组件。主页面首次加载完成后，按物理像素比较含原生边框的窗口尺寸与显示器工作区；默认窗口放不下时自动最大化，避免任务栏遮住控制区。适配只执行一次，不在窗口初始化期间提前最大化。
- 启动：原生窗口／WebView 背景和 HTML 初始底色与 `--app-bg` 一致，防止脚本加载前出现白窗。`main.tsx` 按需载入 App，先用 `StartupShell` 显示窗口控制和资料库加载态；音乐快照与播客活动会话恢复结束后才挂载首页和播放条，不提前展示空曲库或错误的媒体身份。恢复失败且没有可用旧快照时提供原位重试，自动写回继续受成功恢复门闩保护。
- Rust 端（`src-tauri/`）：
  - `lofty` 0.22：音频标签与内嵌封面/歌词读取。
  - `encoding_rs`：修复老旧中文元数据的 GBK 乱码。
  - `walkdir`：曲库扫描。
  - `rfd`：文件夹/歌词文件选择对话框。
  - `reqwest`（rustls）：在线歌词、播客目录/RSS 与音频流式代理/下载请求；安全规则分别见 [歌词](lyrics.md) 与 [播客](podcasts.md)。
  - `feed-rs`：RSS/Atom 播客订阅源解析。
  - `rusqlite`（bundled SQLite）+ `sha2`：音乐与播客数据库持久化及稳定标识。
  - `notify`：递归监听已添加的音乐目录，驱动防抖后的曲库自动刷新。
  - `windows` 0.61（仅 Windows）：系统媒体传输控制（SMTC）集成。

  - `symphonia`：音乐 PCM 解码与有界节拍预分析窗口。

## 模块地图

- `src/App.tsx`：应用组合根。持有唯一的 `<audio ref={audioRef}>` 与跨 hook 共享状态（queue/activeTrackId/playHistory、浮层与 actionNotice、playbackSessionRef 及三个 late-bound ref），按依赖调用 `useNavigation` → `useMusicLibrary` → `useMetadataEnrichment` → `usePodcastPlayback` → `usePlaybackControls` → `useAudioEngine` → `usePlaylists`，selectedPlaylistId 由导航 hook 唯一持有并传回 App 持久化；负责音乐数据库快照恢复/写回、旧 localStorage 迁移、卸载清理、`useSystemMedia` 接线与全部 JSX。共享 ref/state 只在 App 层或拥有它的 hook 创建一次，经参数传递；hook 间反向调用经渲染期赋值的 late-bound ref 保持单向传参（播客 → `playbackControlsRef` 的 arm/seek/toggle/intent；播放控制 → `audioEngineRef`；`openNowPlaying` 的媒体目标）。
- `src/app/podcastPlaybackSettings.ts`：播客倍速/活动单集/自动续播偏好（`zone-podcast-playback-v1`）的常量、类型与 read/patch 纯函数，附 `webkitAudioContext` 全局声明。
- `src/hooks/`（应用组合 hook，由 App 按上述顺序调用）：
  - `useNavigation.ts`：顶层 page、`requestNavigation` 页面过渡、对象入口及来源返回、搜索／历史快捷键、`openNowPlaying`；内部调用 `useCollectionNavigation`。
  - `useCollectionNavigation.ts`：唯一收藏浏览状态（分类、实体、搜索、标签、selectedPlaylistId、连续浏览选择、专辑／歌曲排序与各播放列表浏览排序），有界前进／返回历史以及 DOM 滚动锚点、选中行和焦点恢复；新 revision 提交前由动效内核保存有限退场画面；纯历史转换在 `utils/collectionNavigation.ts`，不依赖播放状态。索引内选择与排序只 patch 当前条目，不增加返回步骤。
  - `useCollectionRows.ts` / `useCollectionItemWindow.ts`：收藏长索引的可见范围渲染、完整数据的键盘定位及历史焦点恢复。歌曲用固定行高留白，名称和封面保留等高锚点并共用区域内的可见性观察器；不改变排序、队列或普通播放列表改序的数据来源。
  - `useCollectionPivot.ts`：收藏分类、详情及返回的方向接线；内部入场与 `useCollectionPanelMotion` 均复用 `useBrowseEntrance.ts`。共享浏览控制器 `motion/browseTransition.ts` 用 `BROWSE_MOTION` 管理收藏、播客及 quickplay 内容的入退场、快速反向及输入接管，分类／搜索保持原位，quickplay 的大字与视差层不继承页面位移。`SurfaceTransition` 与内部 hook 共用异步标题暂隐及首批真实数据入场规则。
  - `useWheelScroll.ts`：收藏与首页内部纵向列表的粗步进滚轮接续，底层 `motion/wheelScroll.ts` 共用动画器与 `snappy` 弹簧；细小连续输入、原生定位和 reduced-motion 保留直接响应。
  - `useMusicLibrary.ts`：folders/tracks/scan/trackActivity 状态、元数据重扫、trackActivity 迁移、只读 `collectionIndex`（albums/artists 等关系集中在 `utils/collectionEntities.ts`）、addFolder/rescan 与 `useLibraryWatcher` 接线。
  - `usePodcastPlayback.ts`：播客会话/队列/进度 domain。对外只返回产品状态与动作（无 ref、无裸 setter），另附 `transport: PodcastTransportBridge` 给播放控制；拥有播客自然结束处理 `handleEpisodeEnded` 与待播消费判定（经 `playbackControlsRef` 的 `hasEpisodeStartedOnDevice` 回查 transport 事实）。
  - `podcastTransport.ts`：`PodcastTransportBridge` 窄接口：零 ref，仅只读值（`activePodcastEpisode`/`podcastPlaybackRate`/`podcastSessionHydrated`）+ 语义方法（`consumePendingPodcastQueueEpisode(episodeId, audioEpisodeId)`、`cancelPendingQueueConsume`、`handleEpisodeEnded` 等）；唯一保留的裸 setter 是 `setPodcastPlaybackStatus`（controls 的 transport 状态上报）。
  - `usePlaybackControls.ts`：拥有 `audioPlayAttemptRef`（唯一递增点在 `beginPlayAttempt`）、autoplay intent、pending start/resume、`podcastAudioEpisodeRef`/`podcastPlaybackStartedEpisodeRef` 等全部 transport ref；`runPlayAttempt` 为唯一 `audio.play()` 成功/失败门闩；音乐 queue/shuffle/repeat/统计、媒体源切换与 audio 事件；onEnded 播客分支委托 `handleEpisodeEnded`；transport 守卫/解析统一走 `src/utils/playbackTransport.ts` 纯函数（`tests/playbackTransport.test.mjs` 行为覆盖）。
  - `useAudioEngine.ts`：Web Audio 图 refs、ensureAudioGraph/resumeAudioGraph、节拍预分析、可视化采样循环与启停、音量应用；以 `AudioEngineHandle` 形式经 ref 交给播放控制。
  - `usePlaylists.ts`：playlists/homePins/喜欢状态与 CRUD、普通列表移除与顺序、智能规则／轮换／排除、homePins 对账和固定；对象导航由 `useNavigation` 负责。
- `src/hooks/useMetadataEnrichment.ts` 与 `src-tauri/src/metadata/`：曲目元数据补全与覆盖；结合音乐库状态接线。无图艺术家在三个入口做精确匹配的自动补充（播放时、信息面板打开时、曲库恢复后的后台顺序批量补齐），共用 30 分钟尝试记录；同一后台遍历随后为无封面专辑补图（仅采用带封面且 ≥95 分的唯一候选），批量筛选纯函数在 `utils/metadata.ts` 的 `selectArtistsForAutomaticBackfill` / `selectAlbumsForAutomaticBackfill`。
- `src/hooks/useAppHotkeys.ts` / `useModalFocus.ts` / `useMountedRef.ts` / `useEntranceCompletion.ts`：全局播放快捷键、对话框焦点、StrictMode 挂载生命周期与入场清理。
- `src/hooks/useCompactMode.ts`：读取原生窗口模式与小屏置顶状态，两种操作共用串行防重锁，失败后回读原生状态；App 只替换视图分支，主音频与播放 hook 保持挂载。小屏期间停用正常收藏导航快捷键与可视化采样。
- `src/hooks/useNativeWindowVisibility.ts`：同步主窗口实际可见/最小化状态，处理 WebView2 隐藏窗口仍报告文档可见的情况；无重叠查询，卸载清理计时与监听，驱动可视化停转和恢复。
- `src/types.ts`：所有共享类型定义（Track、Playlist/SmartPlaylist、HomePin、PodcastFeed/Episode、LyricsDocument/LyricsProvider 等）。`AppPage = "quickplay" | "collection" | "podcasts" | "nowPlaying" | "settings"`。
- `src/constants.ts`：`STORAGE_KEY = "zone-player-state-v1"`、`LIBRARY_SCHEMA_VERSION = 6`、`DEFAULT_PLAYLIST_ID = "favorites"`、`MAX_HOME_PINS = 12`、`VISUALIZER_SAMPLE_COUNT = 180`。
- `src/views/`：页面级视图。
  - 收藏、播客、设置、小屏和播客正在播放视图通过 React `lazy` / `Suspense` 按需加载，等待时使用 `MetroLoader`；React 运行时独立分块。主音频、播放 hook 和音乐正在播放页保持挂载与同步入口，避免加载边界打断播放或共享封面动效。Ctrl+F 的待聚焦意图在收藏内容实际挂载后消费，离开页面清理观察器。
  - `CompactPlayerView.tsx`：Zune HD 风格的小屏界面，消费已有收藏索引、列表解析和音乐／播客播放动作，内部浏览独立于正常页面历史；样式在 `styles/compact-player.css`，功能范围与验证见 [组件规范](../component-guidelines.md)。
  - `QuickplayView.tsx`：Zune quickplay 首页，解析固定内容；`components/tiles/QuickplayPinBoard.tsx` 负责 WP 风格磁贴编辑、重排与外观，稳定表面承载选中缩放与角标，外层 FLIP 接续重排和释放落位；`utils/homePinLayout.ts` 模拟混合尺寸网格并解析空位落点，`usePinDrag.ts` 通过指针捕获管理拖动、抓取偏移、跟随预览与取消，释放时回传浮层矩形，不依赖 WebView2 的 HTML 拖放；`useTileActivity.ts` 管理动态可见性，`motion/tileScheduler.ts` 串行调度翻面及封面墙更新。
  - `src/hooks/useQuickplayPanorama.ts`：首页视口滚动、短滚动条显隐与拖拽、背景视差、鼠标拖动、滚轮／键盘归属与返回位置恢复；`src/utils/quickplayPanorama.ts` 提供键盘分组边界和输入意图的纯函数。背景与滚动条位置由 DOM ref 更新，React 仅接收是否存在横向溢出。
  - `CollectionView.tsx` / `CollectionEntityView.tsx`：收藏索引／搜索／详情外壳及歌曲、专辑、艺术家对象详情，关系通过 `CollectionContext` 的统一入口跳转。
  - `LibraryView.tsx`：艺术家、流派、专辑、歌曲索引与播放列表的展示分派；共享 `CollectionTrackList` 与 `CollectionAlbumTile`。歌曲索引提供可切换方向的列排序；详情中的 `AlbumIndex` 保留打开详情的主动作。
  - `CollectionBrowseView.tsx`：艺术家三栏、专辑两区、流派三栏连续浏览；流派的中栏按专辑艺术家分组。选择只更新内容，独立播放按钮与详情入口各自处理动作；范围解析、流派派生和稳定排序在 `utils/collectionBrowser.ts`。
  - `ArtistBrowser.tsx`：搜索结果中的紧凑艺术家媒体索引；主动作打开艺术家对象。
  - `PlaylistBrowser.tsx`：当前队列与已存播放列表（含智能播放列表）；左侧键盘选择、右侧列排序及来源序号。排序派生显示与显式播放来源，不写回列表；普通列表原始顺序下保留改序。
  - `PodcastView.tsx`：正式播客页壳。负责分区 chrome、六屏切换与浮层（菜单/确认框）；业务状态与数据加载在 `usePodcastViewModel`，各屏 JSX 在 `screens/*`。默认“收听”聚合继续收听与关注更新；“发现”承载榜单、搜索与辅助 RSS；“资料库”展示已关注、稍后听和已下载；节目/单集详情支持关注、保存、播放状态、即时播放、待播与离线下载；“播放列表”管理当前单集与持久待播队列。
  - `src/views/podcast/`：播客视图模块。`usePodcastViewModel.ts` 持有 screen 状态机、缓存读写与 invoke 编排；`api.ts` 为全部 `podcast_*` 命令的薄封装（屏组件不得直接 `invoke`）；`screens/`（Listen/Discover/Library/Playlist/Show/Episode）为展示层；另有 `types.ts`/`constants.ts`/`cache.ts`（模块级缓存单例，不可拆散）/`episodeModel.ts`/`preferences.ts`/`format.ts` 与 `components/`（EpisodeRows、QueueEpisodeRow、EpisodeDetail、ContinueCard、ShowCards、Dialogs、primitives）。
  - `PodcastNowPlayingView.tsx`：播客专属全屏正在播放。提供 15/30 秒跳转、0.5–3× 倍速、睡眠定时、音量、简介、保存、缓冲/错误反馈与待播管理，不复用音乐 `NowPlayingView` 的拼贴和歌词内部状态。
  - `NowPlayingView.tsx`：全屏正在播放。Canvas 封面拼贴与本地艺术家照片背景、照片覆盖后的拼贴停转接线、队列浮层、曲目卡片、收藏按钮、进度/走带控制、歌词模式切换。
  - `SettingsView.tsx`：音乐文件夹管理与在线歌词来源（provider）启用/优先级设置。
- `src/components/`：可复用 UI。`Select` 统一受控单选下拉的键盘、焦点与顶层面板；`PodcastRateButton` 是底栏／全屏播客共用的循环倍速按钮。包括 `Cover`（唯一封面渲染入口：`artPath` 本地文件或 `src` 已解析 URL，`className`/`fallback` 供播客等上下文适配）、`Button`（动作按钮原语，样式在 `styles/controls.css`，variant/size/`busy` 内嵌 MetroLoader）、`Dialog`（深色确认/表单对话框壳，播客确认框共用；SmartPlaylistDialog 编辑器与正在播放浅色保存框为例外）、`tiles/`（Metro 磁贴系统：`Tile`/`FlipTile`/`CycleTile`/`IconicTile`/`MosaicFrames`，样式在 `styles/tiles.css`，quickplay 固定项在用 FlipTile+MosaicFrames，Cycle/Iconic 为备料模板）、`PlayerBar`、`PodcastPlayerBar`、`TransportControls`、`PlaybackProgress`、`ContextMenu`、`InfoPanel`、`Titlebar`、`EmptyState`、`PlaylistDialog`、`SmartPlaylistDialog`、`MetroLoader`（全局 Metro 五点绕圈加载原语，样式在 `styles/base.css` 的 `.metro-loader`/`metro-orbit`，`size`/`large` 控制尺寸，reduced-motion 在 `motion.css` 统一收敛）、`LyricsStage`（歌词舞台主组件；纯 helper 在 `lyricsStage/lyricsLineUtils.ts`，rAF 逐词绘制在 `lyricsStage/useLyricsPaintLoop.ts`，在线搜索与设置面板分别在 `lyricsStage/LyricsSourceBrowser.tsx`/`LyricsSettingsPanel.tsx`）、`NowPlayingMosaicCanvas`、`NowPlayingArtistCanvas` 与 `AudioGlowCanvas`（拼贴、艺术家照片和真实音频光焰三个 Canvas 视觉层）。
- `src/hooks/`（独立功能 hook）：
  - `useLibraryWatcher.ts`：配置 Rust 目录监听、接收文件变化事件并在 800ms 防抖后触发曲库刷新。
  - `useLyrics.ts`：歌词加载/缓存/在线搜索状态机（本地缓存键 `zone-local-lyrics-v1`）。
  - `useLyricsDisplaySettings.ts`：歌词翻译/音译/背景人声显隐与字号偏好（键 `zone-lyrics-display-v1`）。
  - `useLyricsProviderSettings.ts`：歌词 provider 启用与优先级（键 `zone-lyrics-providers-v1`）。
  - `useSystemMedia.ts`：与 Rust 端 SMTC 集成（`update_system_media*` 命令与媒体按键事件）。
- `src/lyrics/providers.ts`：AMLL TTML DB、QQ 音乐、网易云音乐、LRCLIB 四个在线歌词 provider 的定义与编排。自动查找按优先级回退并在高置信命中后停止；手动在线搜索并行查询全部已启用来源。请求统一经 Rust 命令 `request_lyrics_provider` 中转。
- `src/utils/`：共享工具模块（详见各测试）。
  - `touchInteractions.ts`：应用根节点的 DOM 触摸守卫，处理滚动／取消／多指后的兼容点击与已标记实体的长按菜单；`hooks/useTouchInteractions.ts` 负责安装和生命周期清理，行为边界见 [组件规范](../component-guidelines.md)。
  - `music.ts`：专辑分组、曲目排序、播放列表默认值、`normalizePlaylists`。
  - `podcastArtwork.ts` / `podcastPlayback.ts`：播客代理封面 URL、播放模型归一化、实时播放状态覆盖和待播顺序移动。
  - `playback.ts`：队列移动/随机顺序/边界解析。
  - `smartPlaylist.ts`：智能播放列表规则求值与归一化。
  - `homePins.ts`：quickplay 固定项的归一化、移动、外观设置与对账。
  - `visualizer.ts` / `beatAnalysis.ts` / `audioGlow.ts` / `nowPlayingWall.ts` / `nowPlayingCanvas.ts`：音频帧、节拍网格、Zune 光焰与封面拼贴的纯计算部分；`mosaicLighting.ts` / `mosaicProjection.ts` 分别维护环境点光与转面纹理投影，`nowPlayingArtist.ts` 维护本地照片池与场景时钟。
  - `visualizerBus.ts`：可视化帧的单槽 latest-frame 总线（`publishVisualizerFrame` / `getVisualizerFrame`）。`useAudioEngine` 采样循环发布，App 普通页面或正在播放页的 `AudioGlowCanvas` 在活动的 rAF 中拉取；`NowPlayingMosaicCanvas` 的封面／色场按独立环境时钟绘制，共用文档和原生窗口可见性信号。暂停/减少动态效果后收敛停转，静音时光焰停转，不经 React state/props。页面浏览不重启采样，小屏与播客播放停用音乐可视化。
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
  - `surfaceTransition.ts`：顶层页面交接，收藏／播客委托 `browseTransition.ts`；`collectionPivot.ts` 保留收藏方向和快照接线。`surfaceSnapshot.ts` 共享有限静态快照及滚动恢复，`contentEntrance.ts` 共享首屏条目的有界选择、透明度显现及滚动锚定生命周期。
  - `useReducedMotion.ts`：reduced-motion 统一 hook。
- `src/styles.css`：按序 `@import` `src/styles/` 下的拆分 CSS：`base`、`controls`（Button 原语变体与尺寸）、`collection`、`podcasts`、`podcast-now-playing`、`quickplay`、`player`、`now-playing`、`lyrics`、`overlays-settings`、`playlists`、`tiles`（Metro 磁贴系统）、`motion`（动效原语层：feather 入场、页面/浮层出入场、反馈动画、共享 `.tilt-pressed` 倾斜规则、唯一 reduced-motion 块）、`animations-responsive`（正在播放入场编排与响应式）。
- `src-tauri/src/lib.rs`：应用初始化接线。包含系统托盘、`update_system_media`/`update_system_media_timeline` 薄命令与 `pub fn run()`（协议注册、状态初始化、命令注册）；业务命令按模块注册，例如 `music::music_scan_library`。
- `src-tauri/src/webview_runtime.rs`：Windows 窗口创建前的 WebView2 检测；优先系统运行时，缺失时选择主程序相邻的包内离线运行时。打包与版本维护见 [安装与发布](../../packaging/README.md)。
- `src-tauri/src/window_mode.rs`：主窗口专用的 `get_compact_mode` / `set_compact_mode` / `set_compact_pinned`，统一返回模式与实际置顶状态。仅接受模式或置顶布尔值，置顶操作限小屏期间；原生端保存正常窗口几何、最大化与置顶快照，应用预设尺寸与工作区边界并处理回滚。不开放任意尺寸／位置参数，不增加通用窗口 capabilities。
- `src-tauri/src/db/` 与 `src-tauri/src/music/`：音乐 SQLite schema、状态快照/迁移、可取消扫描、特征与电台逻辑；`beat_window.rs` 经 Symphonia 有界解码供前端 Worker 预分析。
- `src/workers/beatAnalysis.worker.ts`：节拍计算 Worker；由 `useAudioEngine` 管理请求与缓存。
- `src-tauri/src/diagnostics.rs` 与 `src/utils/diagnostics.ts`：本地诊断和保存对话框导出。
- `src-tauri/src/library.rs`：曲库扫描与目录监听。命令 `select_music_folder`、`watch_music_folders`；底层扫描 helper 供 `music_scan_library` 调用；`LibraryWatcherState`、`MusicFolder`/`Track`/`ScanResult`/`LibraryFilesChanged`、`is_supported_audio`、`track_from_path`、封面提取与缓存（内嵌封面写入缓存目录）、GBK 乱码修复族、`stable_track_id`。
- `src-tauri/src/lyrics.rs`：本地歌词。命令 `select_lyrics_file`、`export_lyrics_file`（`LYRICS_EXPORT_CONTENT_LIMIT` + 保存对话框写文件）、`load_local_lyrics`；内嵌标签歌词、同目录 sidecar 歌词（`.ttml` → `.lrc` → `.txt`，文件名和扩展名大小写不敏感）、UTF-16/GBK 解码修复。
- `src-tauri/src/lyrics_provider.rs`：在线歌词中转。命令 `request_lyrics_provider`（白名单校验、超时钳制、响应上限、网关重试）与 `decrypt_qrc_lyrics`，以及全部 provider URL/请求体校验 helper。
- `src-tauri/src/audio_protocol.rs`：`zone-audio` 自定义协议（`serve_audio_protocol`）：CORS 安全的本地音频播放与 Web Audio 分析，含字节范围（`Accept-Ranges`/`Content-Range`）与正确的音频 content type。
- 上述 Rust 模块各自内带 `#[cfg(test)]` 单元测试。
- `src-tauri/src/podcast/`：播客目录模块（对外路径保持 `podcast::xxx`，由 `mod.rs` re-export）。`mod.rs` 持有 `PodcastState`、跨模块共享常量与 re-export；`types.rs` 为全部 pub DTO；`util.rs` 通用小工具与 ISO8601 历法解析；`network.rs` 公共 URL/DNS/重定向 SSRF 校验、限流读取与响应工具；`apple.rs` Apple 中国区热门榜与搜索；`feed_parse.rs` 20 MiB RSS 限流拉取、字节修复、命名空间解析与归一化；`store.rs` SQLite schema/迁移与订阅/刷新写入；`query.rs` 查询侧与稍后听/已播；`chapters.rs` 单集详情与章节；`queue.rs` 待播队列；`downloads.rs` 受控目录下载/续传/删除、进度保存与文件守卫；`stream_protocol.rs` `zone-podcast` 分块 Range 代理与音频魔数识别；`artwork_protocol.rs` `zone-podcast-artwork` 限流图片代理；`commands.rs` 为 `#[tauri::command]` 薄壳；测试按被测代码归属下沉到各文件末尾的 `#[cfg(test)] mod tests`（共享 fixture 在 `test_support.rs`），真实网络 smoke 仍仅在 `ZONE_PODCAST_LIVE=1` 后运行。
- `src-tauri/src/qrc.rs`：有边界限制的 QQ QRC 解密/解压实现；解密后的逐词时间轴由前端 `src/utils/qrc.ts` 转换为统一 TTML 再进入通用解析器。
- `src-tauri/src/system_media/`：Windows SMTC 集成（`mod.rs` 为跨平台入口，`windows_impl/` 为 Windows 实现：设置 AppUserModelID、媒体信息/时间线更新、媒体按键事件转发到前端）。
- `docs/`：本地探索记录与视觉证据，整个目录被忽略，其他 checkout 不保证存在。需要共享的规则与验证步骤放在 `design/`。
- `design/`：版本控制中的设计规范与 `engineering/` 专题规则；根目录任务索引决定何时读取。
- `scripts/`：一次性重构 codemod（PodcastView 拆分时使用的提取/接线/测试路径迁移脚本），仅作历史留档，不在构建链路中。
