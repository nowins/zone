# Zone 组件与设计规范

本文档是 Zone 界面风格的约束性规范：新组件、新动效、新页面都应先对照本文档，再动手。它只记录已落地的事实与可执行的规则；探索性设计笔记仍放在各专题文档（如 `docs/lyrics-experience-plan.md`）。

## 1. 设计原则

1. **Zune 4.8 是第一参照**。克制的纵深感，不要现代玻璃拟态仪表盘；避免卡片堆砌。
2. **内容即装饰**。尽可能使用真实封面与媒体派生色；不加与音乐无关的装饰性渐变/光斑。
3. **大号、低字重排版**。展示性文字用 200–300 字重、clamp() 流式字号、负字距；功能性文字保持可读且克制。
4. **无解释性文案**。界面不写教学式句子；功能性 UI 文案一律中文（`tests/localization.test.mjs` 有守卫）。
5. **动效有目的、可打断、时间短**。只动 transform/opacity；UI 动效 ≤300ms（循环加载器除外）；尊重 `prefers-reduced-motion`。

## 2. 设计令牌

### 2.1 色彩（`src/styles/base.css` `:root`）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--app-bg` / `--app-bg-raised` | `#0b070c` / `#140d15` | 应用底 / 抬升面 |
| `--text` | `#f7f2f6` | 主文字 |
| `--muted` / `--quiet` / `--faint` | 58% / 34% / 13% 白 | 次级文字三级衰减 |
| `--accent`（`--accent-pink`） | `#f12486` | 主强调色（粉） |
| `--accent-orange` | `#ff5b19` | 渐变尾色、光焰 |

规则：强调色只用于当前态、焦点框、关键操作；不要大面积铺色。左侧 12px 粉橙渐变条（`.shell::before`）是唯一的品牌装饰。

### 2.2 排版

- 字体栈：`"Segoe UI Variable Display", "Segoe UI Variable", "Segoe UI Light", "Microsoft YaHei UI", "Segoe UI", sans-serif`，全局 `user-select: none`（输入框除外）。
- 展示标题：`font-weight: 200–250`，`letter-spacing` 约 `-0.05em`，`line-height < 1`。
- 正文/列表：400；次级信息用 `--muted`。
- 幽灵大字（`.quickplay-ghost` / `.collection-ghost` / `.podcast-ghost`）：`position: absolute`、低透明度、允许裁切，`aria-hidden`。

### 2.3 动效令牌（`src/motion/tokens.ts`，经 `applyMotionTokens()` 注入 `:root`）

| 类别 | 令牌 | 值 |
| --- | --- | --- |
| 时长 | `--motion-instant` / `press` / `micro` / `content` / `page` / `chrome` / `loader` | 80 / 110 / 160 / 220 / 260 / 700 / 4500 ms |
| 缓动 | `--motion-ease-standard` / `entrance` / `exit` / `emphasis` | 强 ease-out / 入场 / 加速离场 / 轻微过冲 |
| 位移 | `--motion-drift-s` / `m` / `l` | 8 / 22 / 48 px |
| 错峰 | `--motion-stagger-step` / `max` | 24 / 144 ms |
| 弹簧 | `SPRING_PRESETS.snappy` / `gentle` / `bouncy` | 按压回弹 / 页面级 / 确认反馈 |

规则：**新动效一律消费令牌，禁止就地硬编码时长和曲线**。`loader` 只用于循环加载器，不得作为过渡时长。

## 3. 动效语言

### 3.1 页面转场（`src/motion/pageTransition.ts`）

- 平级页 pivot：沿导航序（quickplay → collection → podcasts → settings）方向感知滑入滑出；nowPlaying 在其上 push/pop。
- 进入 = `--motion-drift` 水平位移 + 透明度（`motion-page-enter`，page 档 260ms，ease-entrance）；退出 = 反向半程（`motion-page-exit`，micro 档，ease-exit 加速）。
- **不要给整页根节点加 scale**——会让页面标题产生垂直漂移（两次实测教训）。纵深感属于小元素，不属于页面。

### 3.2 列表级联（feather）

- 统一 `motion-feather-in`：位移 drift-m + `scale(0.96→1)` + 透明度，`backwards` 填充（`both` 会永久压住 transform，禁止）。
- 逐项错峰用 `--stagger`，步进 24ms、封顶 144ms；quickplay 分组级错峰 60ms（0/60/120/180）。
- 级联期间内容保持可交互。

### 3.3 按压反馈

- 普通按钮：`:active` 时 `scale(0.97)`，press 档 110ms。
- 磁贴（quickplay pins、专辑磁贴、历史封面）：3D 倾斜按压，`src/utils/tiltPress.ts` 的 `tiltPressDown` / `tiltPressClear`。参数固定：±3.5°、`scale(0.97)`、`perspective(900px)`、松手 ease-emphasis 回弹。新磁贴面直接挂这两个处理器，不要另写参数。

### 3.4 浮层与退出

- 浮层入场用 swivel（小角度 rotateY/X + 位移，`@starting-style`）。
- 所有可退出元素挂 `.motion-exit` 家族（菜单、面板、对话框、toast），退出比入场快且行程约半。
- React 侧用 `src/motion/presence.tsx` 的 `Presence` 编排卸载时机；JS 等待时长必须经过 `resolveExitDurationMs()`（reduced-motion 下收缩到 instant 档）。

### 3.5 加载：`MetroLoader` 是唯一加载原语

- 一切等待指示（网络请求、扫描、缓冲、按钮内联加载）都用 `src/components/MetroLoader.tsx`——Metro 五点绕圈（4500ms 循环，两点/圈分段缓动）。
- 尺寸：`size={px}`（默认 16）或 `large`（40，用于整区加载态）；几何由 `--loader-size` 派生，不要覆写点径/轨道。
- 整区加载（如 `.podcast-opening-state`）：延迟淡入（`podcast-loading-reveal` 模式），快网络下不闪烁。
- 禁止引入旋转图标、`border` 转圈等其他 spinner 形式。

### 3.6 共享元素

- 封面在页面间的连续飞行走 `src/motion/coverFlip.ts` 的 FLIP 注册表（`cover:{trackId}`），不要自写 rect 动画。

### 3.7 Reduced motion 契约

- CSS 侧：`motion.css` 的 `@media (prefers-reduced-motion: reduce)` 统一关停列表；新动效类必须加入对应关停规则（`.metro-loader > span` 已有静态五点兜底）。
- JS 侧：任何按动画时长等待的逻辑都过 `resolveExitDurationMs()`。

### 3.8 画布视觉层

- `NowPlayingMosaicCanvas`、`AudioGlowCanvas`、`CollectionArtworkBackdrop` 是仅有的三个 Canvas 视觉层；可视化必须吃真实音频分析数据，禁止空闲动画冒充。光焰保持低频驱动的红/橙低暗 glow，不是均衡器。

## 4. 组件清单与用法

### 4.1 原语（`src/components/`）

| 组件 | 职责与规则 |
| --- | --- |
| `Cover` | 唯一封面渲染入口；统一占位、尺寸档、`index` 错峰 |
| `MetroLoader` | 唯一加载指示（见 §3.5） |
| `EmptyState` | 空态/扫描态；一行说明 + 一个动作，不写解释段落 |
| `ContextMenu` / `PodcastEpisodeContextMenu` | 右键菜单；swivel 入场；系统右键全局抑制 |
| `InfoPanel` | 元数据查看；右缘 swivel 入场 |
| `PlaylistDialog` / `SmartPlaylistDialog` / `AddToPlaylistDialog` / `MetadataEditDialog` / `MetadataSearchDialog` | 对话框统一：遮罩淡入 + 盒体 rotateX 下沉入场；异步动作按钮内嵌 `MetroLoader` |
| `Titlebar` / `AppHeader` | 无边框窗口 chrome 与 pivot 导航；选中态只变色 + 下划线，**不做位移** |

### 4.2 播放 chrome

- `PlayerBar` / `PodcastPlayerBar`：底部 74px 常驻；媒体源二选一，互斥。
- `TransportControls`、`PlaybackProgress`：极简线性控制；图标切换用 `motion-icon-swap`，收藏确认用 `motion-confirm`。

### 4.3 页面级

- 页面根动画统一 `motion-page-enter`；不再新增页面级入场关键帧。
- quickplay：磁贴墙 + 分组级联；磁贴可拖拽排序（编辑态下禁用倾斜按压）。
- now playing：拼贴背景 + 光焰 + 歌词模式同空间切换；chrome 无操作约 5s 进入沉浸态。
- 播客：`src/views/podcast/` 按 screens/components 分层，加载态全部走 `PodcastLoading`（内含 `MetroLoader`）。

## 5. 交互与可达性

- 焦点可见：`:focus-visible` 用 1px `--accent` 描边、3px 偏移，不要删。
- 键盘预期：全景横向滚动支持方向键/Home/End/滚轮；列表 Enter/Space 触发。
- 文本默认可选中仅限输入框；应用文本不可选。
- 窗口控制经 Tauri capabilities 最小授权，不要扩大权限面。

## 6. 新增组件/动效检查清单

1. 动效参数全部来自 `src/motion/tokens.ts` 令牌；加载态用 `MetroLoader`。
2. 只动 transform/opacity；UI 过渡 ≤300ms。
3. 加入 reduced-motion 关停规则；JS 等待用 `resolveExitDurationMs()`。
4. 新功能性文案为中文；跑 `npm test` 确认源码/CSS 守卫同步更新。
5. 改了结构、命令或约定就同步 `AGENTS.md` 与本文档。
