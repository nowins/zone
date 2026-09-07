# Zone 组件与设计规范

本文档是 Zone 界面风格的规范：新组件、新动效、新页面都应先对照本文档。产品与交互边界是约束；参数表描述当前实现，以标注的源码为事实源，可在任务范围内经验证调整。探索性设计笔记可放在本地 `docs/`，共享规则与必要验证保留在版本控制中。

## 1. 设计原则

1. **Zune 4.8 是第一参照**。克制的纵深感，不要现代玻璃拟态仪表盘；避免卡片堆砌。
2. **内容即装饰**。尽可能使用真实封面与媒体派生色；不加与音乐无关的装饰性渐变/光斑。
3. **大号、低字重排版**。展示性文字用 200–300 字重、clamp() 流式字号、负字距；功能性文字保持可读且克制。
4. **无解释性文案**。界面不写教学式句子；功能性 UI 文案一律中文（`tests/localization.test.mjs` 有守卫）。
5. **动效有目的、可打断、时间短**。常规交互优先 transform/opacity，通常采用 ≤260ms 的通用 token；分层入场、媒体背景和加载循环有各自编排，适用范围见 [动效系统](motion-system.md)。尊重 `prefers-reduced-motion`。

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
- 播客正在播放的时间、倍速、睡眠与动作标签至少 12px；节目/单集详情只保留一个内容大标题。保存单集统一称“稍后听”，插入待播首位称“下一集播放”。
- 幽灵大字（`.quickplay-ghost` / `.collection-ghost` / `.podcast-ghost`）：`position: absolute`、低透明度、允许裁切，`aria-hidden`。

### 2.3 动效令牌（`src/motion/tokens.ts`，经 `applyMotionTokens()` 注入 `:root`）

| 类别 | 令牌 | 值 |
| --- | --- | --- |
| 时长 | `--motion-instant` / `press` / `micro` / `content` / `page` / `chrome` / `cycle` / `loader` | 80 / 110 / 160 / 220 / 260 / 700 / 800 / 4500 ms |
| 缓动 | `--motion-ease-standard` / `entrance` / `exit` / `emphasis` / `dissolve` | 强 ease-out / 入场 / 加速离场 / 轻微过冲 / 闲置缓慢溶解 |
| 位移 | `--motion-drift-s` / `m` / `l` | 8 / 22 / 48 px |
| 错峰 | `--motion-stagger-step` / `max` | 24 / 144 ms |
| 弹簧 | `SPRING_PRESETS.snappy` / `gentle` / `bouncy` | 按压回弹 / 页面级 / 确认反馈 |

规则：**新动效一律消费令牌，禁止就地硬编码时长和曲线**。`cycle` 用于慢速环境循环（磁贴轮换交叉淡化），`loader` 只用于循环加载器，两者都不得作为过渡时长。

正在播放的分层入场使用同文件中的 `NOW_PLAYING_MOTION` 编排值（队列、曲目卡及各自延迟），不扩展通用时长档位。Canvas 的最终静帧收敛时间同样来自此表。

光焰形状由真实频段包络与瞬态决定，峰位、宽度与局部亮度应随乐段变化，不能用固定中央山形或静音兜底动画覆盖信号。保持底部低暗光焰与控制区可读性；画布尺寸以 `src/styles/now-playing.css` 为准。色彩连续性、DSP 参数及回归场景统一见 [播放与正在播放视觉](engineering/playback-visuals.md)。

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
- 磁贴（Metro tiles、quickplay 专辑封面、专辑网格）：3D 倾斜按压只有一条规则——`motion.css` 的 `.tilt-pressed`。`src/utils/tiltPress.ts` 的 `tiltPressDown` / `tiltPressClear` 按按压点写入 `--tilt-rx` / `--tilt-ry`，几何固定为 Lumia 校准的 ±10°、`scale(0.94)`、`perspective(600px)`（见 `tests/tiles.test.mjs`）；松手由各面基类的 content 档 ease-emphasis 回弹。新磁贴面直接用 `Tile` 或挂这两个处理器，不要在页面 CSS 里覆写倾斜参数。播放历史的紧凑文字行使用 `Button` 常规按压反馈。

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
| `tiles/`（`Tile` / `FlipTile` / `CycleTile` / `IconicTile` / `MosaicFrames`） | Metro 磁贴系统（`tiles.css`）：`Tile` 提供统一倾斜按压与裁切表面；`FlipTile` 有 peek/flip 两种背面揭示；`MosaicFrames` 是 People-hub 封面墙；`CycleTile` / `IconicTile` 是备料模板——暂无消费方，接入前不算「已在用」。quickplay 固定项由 `QuickplayPinBoard` 编排，宽磁贴与播客用 peek，其余音乐磁贴用 flip；小磁贴静态显示 |
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
- quickplay：保留 Zune 横向全景与分组，固定区采用 WP 8.1 的小／中／宽磁贴，兼容既有大磁贴。网格以小磁贴为单位，中为 2×2、宽为 4×2、大为 4×4；组宽随内容增长，窄窗口不强留半屏空白。
- 首页底部使用悬浮短滚动条，不另列一排重复的分组导航。仅在滚动时显现、停止后淡出；拖住滑块或键盘聚焦时保持可操作，内容全部放得下时禁用并隐藏。背景大字、底色和内容按不同速度随真实滚动位置移动，停下浏览后不自行漂移。“继续播放”封面按区块可用高度缩小，为曲名和艺术家留出完整空间。
- 播放历史用等高双列展示小封面、曲名和艺术家，不再单独放大第一项；按真实最近播放顺序最多显示 12 首，排除当前曲目、重复及已移除记录，不用曲库内容补满。窄窗口在区块内纵向滚动；整行支持播放、键盘激活和右键操作，长文字保留省略与完整提示。
- 固定区由 `QuickplayPinBoard` 负责：编辑按钮、长按或 F2 进入，选中一块后显示取消固定与缩放角标；拖动采用指针捕获，磁贴跟随指针并预览重排，在固定区内释放后保存。移出固定区松手、Esc、指针取消或窗口失焦均取消当前拖动，不改持久顺序。Alt+左右移动、Alt+上下缩放、非拖动时 Esc 完成；编辑时不触发播放。
- “外观”用 `Dialog` + `Presence` 提供尺寸、封面／纯色背景和动态内容开关。中及以上尺寸正面保留名称，小磁贴保留封面或图标，按钮始终有稳定的可访问名称；播客小磁贴可显示未听数。外观与顺序按 [持久化规范](engineering/persistence.md) 保存。
- `FlipTile` 揭示真实歌曲／专辑／播放列表信息或播客最新单集，`MosaicFrames` 只替换尚未显示的封面；编辑、悬停、键盘聚焦、页面隐藏、离开可视区及 reduced-motion 时暂停自动变化。
- now playing：拼贴背景 + 光焰 + 歌词模式同空间切换；chrome 无操作约 5s 进入沉浸态。
- 播客：`src/views/podcast/` 按 screens/components 分层，加载态全部走 `PodcastLoading`（内含 `MetroLoader`）。
- 播客 hover 语言（已登记）：封面卡用第 4 级（封面降 opacity、轻抬 2px），列表行只做文字即时提亮，均无行级背景，详见 `design/motion-system.md` Hover 反馈分级。
- 播客文本动作条（单集详情 `.podcast-detail-actions`、下载/待播批量条）：hover 纯白、`.primary` 实心 accent、`.danger` 文本红，是播客页面级语言，不走 `Button` variant；新增播客行内动作沿用同一模式。
- 播客正在播放的队列面板与倍速/睡眠 popover：进退场规则就近放在 `podcast-now-playing.css`（token 时长 + `Presence` 生命周期与共享表一致），reduced-motion 仍由 `motion.css` 统一块收敛。
- 发现页最近搜索是输入框聚焦时的建议层，不占页面行；进退场走 `Presence` + `motion.css` 的 context-menu 表，reduced-motion 仍由统一块收敛。
- 播客屏内容走 feather 入场：区块（`.podcast-content-section`）、单集行、节目卡、继续收听卡与待播行都在 `motion.css` feather 组与播客错峰表（24ms 步进、144ms 封顶）；行键稳定，进度刷新不会重播入场。
- 播客 chrome 按压：正在播放的返回/走带/倍速/睡眠触发与行内播放按钮（`.podcast-play-action`）都在 `motion.css` 按压组（micro 过渡 + `:active scale(0.97)`）；播客底栏直接复用音乐 chrome 类（`.zune-controls` 等），不另起按钮样式。

## 5. 交互与可达性

- 焦点可见：`:focus-visible` 用 1px `--accent` 描边、3px 偏移，不要删。
- 键盘预期：全景视口聚焦时，左右方向键／PageUp／PageDown 按分组移动，Home／End 到两端，键盘定位即时完成；嵌套控件保留自己的快捷键，列表 Enter/Space 触发。
- 首页空白处可鼠标拖动，滚轮默认横移；有纵向溢出的区块内，纵向滚轮始终归该区块，包括上下边界。Shift+滚轮或触控板横向输入可主动横移；弹窗与底部播放条不接管为首页滚动。磁贴本体的点击、长按和编辑拖动仍归磁贴负责。
- 文本默认可选中仅限输入框；应用文本不可选。
- 窗口控制经 Tauri capabilities 最小授权，不要扩大权限面。

## 6. 新增组件/动效检查清单

1. 动效参数全部来自 `src/motion/tokens.ts` 令牌；加载态用 `MetroLoader`。
   按钮统一 `Button`，确认/表单对话框统一 `Dialog`，磁贴面统一 `tiles/`。
2. 常规交互优先 transform/opacity 与通用短时长 token；特殊编排遵循动效系统的适用范围。
3. 加入 reduced-motion 关停规则；JS 等待用 `resolveExitDurationMs()`。
4. 新功能性文案为中文；跑 `npm test` 确认源码/CSS 守卫同步更新。
5. 改了组件或视觉约定就同步本文；全局规则或文档入口变化才更新根目录 `AGENTS.md`。

磁贴交互验证同时覆盖长按后的点击抑制、取消拖动、尺寸混排、键盘焦点、外观取消／保存／恢复，以及默认和最小窗口下的角标与长标题裁切。运行时入口为 `tests/tileInteraction.test.mjs`。

首页全景验证覆盖键盘按分组移动、空白处拖动、短滚动条显隐／拖拽／键盘焦点、滚轮与纵向列表的边界、弹窗滚轮隔离、离开再返回后的层位置恢复、窗口缩放和 reduced-motion；默认 1180×760、最小 920×620 均检查滚动条不占用布局、“继续播放”文字与历史列表可读性。滚动运行时入口为 `tests/panoramaBehavior.test.mjs`，历史入口为 `tests/quickplayBlocks.test.mjs` 与 `tests/quickplayBehavior.test.mjs`；源码守卫不能替代真实窗口检查。
