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
| 时长 | `--motion-instant` / `press` / `micro` / `content` / `page` / `chrome` / `cycle` / `loader` | 80 / 110 / 160 / 220 / 260 / 700 / 800 / 4500 ms |
| 缓动 | `--motion-ease-standard` / `entrance` / `exit` / `emphasis` | 强 ease-out / 入场 / 加速离场 / 轻微过冲 |
| 位移 | `--motion-drift-s` / `m` / `l` | 8 / 22 / 48 px |
| 错峰 | `--motion-stagger-step` / `max` | 24 / 144 ms |
| 弹簧 | `SPRING_PRESETS.snappy` / `gentle` / `bouncy` | 按压回弹 / 页面级 / 确认反馈 |

规则：**新动效一律消费令牌，禁止就地硬编码时长和曲线**。`cycle` 用于慢速环境循环（磁贴轮换交叉淡化），`loader` 只用于循环加载器，两者都不得作为过渡时长。

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

- 普通按钮：`:active` 时 `scale(0.97)`，press 档 110ms；`Button` 原语自带，其余 chrome 按钮沿用 `motion.css` 按压组。
- 磁贴（Metro tiles、quickplay 专辑/历史封面、专辑网格）：3D 倾斜按压只有一条规则——`motion.css` 的 `.tilt-pressed`。`src/utils/tiltPress.ts` 的 `tiltPressDown` / `tiltPressClear` 按按压点写入 `--tilt-rx` / `--tilt-ry`，几何固定为 Lumia 校准的 ±10°、`scale(0.94)`、`perspective(600px)`（见 `tests/tiles.test.mjs`）；松手由各面基类的 content 档 ease-emphasis 回弹。新磁贴面直接用 `Tile` 或挂这两个处理器，不要在页面 CSS 里覆写倾斜参数。

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
| `Button` | 唯一动作按钮原语（样式在 `controls.css`）：variant 定角色（`outline` 描边默认 / `primary` 强调 / `danger` 危险 / `solid` 填充 CTA / `page` 左侧强调条页面动作 / `ghost` 纯文本），size 定几何（`sm`/`md`/`lg`/`xl`）；`busy` 自动禁用并前置 `MetroLoader`，图标走 `icon` prop |
| `Dialog` | 深色确认/表单对话框壳：遮罩 + kicker/标题 + 可选右侧动作行，Escape/点遮罩取消、`busy` 时锁定；保留 `playlist-dialog` 基类让 swivel 入场与 Presence 退场继续生效。例外：`SmartPlaylistDialog` 是编辑器表面（不走壳，底部动作用 `Button`）；正在播放的保存列表对话框是刻意的浅色主题，保持独立 |
| `tiles/`（`Tile` / `FlipTile` / `CycleTile` / `IconicTile` / `MosaicFrames`） | Metro 磁贴系统（`tiles.css`）：`Tile` 提供统一倾斜按压与裁切表面；`FlipTile` 有 peek/flip 两种背面揭示；`MosaicFrames` 是 People-hub 封面墙；`CycleTile` / `IconicTile` 是备料模板——暂无消费方，接入前不算「已在用」。quickplay 固定项用 `FlipTile variant="flip"` + `MosaicFrames` |
| `Cover` | 唯一封面渲染入口：`artPath`（本地文件）与 `src`（已解析 URL）二选一；默认音乐封面类（accent-index 渐变占位 + 首字母），`className`/`fallback` 供上下文适配——播客经 `PodcastArtwork` 适配器（`podcast-artwork` 类 + 字符/Podcast 图标占位） |
| `MetroLoader` | 唯一加载指示（见 §3.5） |
| `EmptyState` | 页面级空态（空曲库：字标 + `Button` solid xl 动作）；区块级空态/加载用播客 `primitives.tsx` 的 `PodcastEmpty` / `PodcastLoading`（`MetroLoader` + 延迟淡入）。不写解释段落 |
| `ContextMenu` / `PodcastEpisodeContextMenu` | 右键菜单；swivel 入场；系统右键全局抑制 |
| `InfoPanel` | 元数据查看；右缘 swivel 入场 |
| `PlaylistDialog` / `AddToPlaylistDialog` / `MetadataEditDialog` / `MetadataSearchDialog` / 播客确认框 | 全部建在 `Dialog` 壳上，动作行用 `Button`；遮罩淡入 + 盒体 rotateX 下沉入场由壳的基类继承 |
| `Titlebar` / `AppHeader` | 无边框窗口 chrome 与 pivot 导航；选中态只变色 + 下划线，**不做位移** |

### 4.2 播放 chrome

- `PlayerBar` / `PodcastPlayerBar`：底部 74px 常驻；媒体源二选一，互斥。
- `TransportControls`、`PlaybackProgress`：极简线性控制；图标切换用 `motion-icon-swap`，收藏确认用 `motion-confirm`。

### 4.3 页面级

- 页面根动画统一 `motion-page-enter`；不再新增页面级入场关键帧。
- quickplay：固定项是 `tiles/` 磁贴墙（`FlipTile` 翻面揭示动态 + `MosaicFrames` 封面墙）+ 分组级联；可拖拽排序（编辑态下禁用倾斜按压与翻面）。
- now playing：拼贴背景 + 光焰 + 歌词模式同空间切换；chrome 无操作约 5s 进入沉浸态。
- 播客：`src/views/podcast/` 按 screens/components 分层，加载态全部走 `PodcastLoading`（内含 `MetroLoader`）。

## 5. 交互与可达性

- 焦点可见：`:focus-visible` 用 1px `--accent` 描边、3px 偏移，不要删。
- 键盘预期：全景横向滚动支持方向键/Home/End/滚轮；列表 Enter/Space 触发。
- 文本默认可选中仅限输入框；应用文本不可选。
- 窗口控制经 Tauri capabilities 最小授权，不要扩大权限面。

## 6. 新增组件/动效检查清单

1. 动效参数全部来自 `src/motion/tokens.ts` 令牌；加载态用 `MetroLoader`。
   按钮统一 `Button`，确认/表单对话框统一 `Dialog`，磁贴面统一 `tiles/`。
2. 只动 transform/opacity；UI 过渡 ≤300ms。
3. 加入 reduced-motion 关停规则；JS 等待用 `resolveExitDurationMs()`。
4. 新功能性文案为中文；跑 `npm test` 确认源码/CSS 守卫同步更新。
5. 改了结构、命令或约定就同步 `AGENTS.md` 与本文档。
