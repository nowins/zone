# Zone 组件与设计规范

本文档是 Zone 界面风格的规范：新组件、新动效、新页面都应先对照本文档。产品与交互边界是约束；参数表描述当前实现，以标注的源码为事实源，可在任务范围内经验证调整。探索性设计笔记可放在本地 `docs/`，共享规则与必要验证保留在版本控制中。

## 1. 设计原则

1. **Zune 4.8 是第一参照**。克制的纵深感，不要现代玻璃拟态仪表盘；避免卡片堆砌。
2. **内容即装饰**。尽可能使用真实封面与媒体派生色；不加与音乐无关的装饰性渐变/光斑。
3. **大号、低字重排版**。展示性文字用 200–300 字重、clamp() 流式字号、负字距；功能性文字保持可读且克制。
4. **无解释性文案**。界面不写教学式句子；功能性 UI 文案一律中文（`tests/localization.test.mjs` 有守卫）。
5. **动效有目的、可打断、有接续**。常规交互优先 transform/opacity，通常采用 ≤260ms 的通用 token；分层入场、媒体背景和加载循环有各自编排，适用范围见 [动效系统](motion-system.md)。尊重 `prefers-reduced-motion`。

## 2. 设计令牌

设置中的“关于”展示应用版本与本地隐私说明，包括 WebView2/SmartScreen 的微软隐私入口，以及 MSIX 与独立安装版本的卸载数据语义。反馈和新版下载入口只在构建时提供真实 HTTPS 发布地址后展示；不使用占位网址。隐私说明复用 `Dialog` / `Presence`，通过 portal 挂到 body，文本区域可独立滚动并支持键盘操作。

设置页的标题和音乐／播客／常规导航常驻，三个分类各自通过 `.settings-content` 滚动并预留稳定的滚动条空间；分类切换不改变页头位置，保留各分类滚动位置与播客未保存草稿。最小窗口沿用同一滚动容器，音乐网格不再另开滚动层。

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

- 字体令牌以 `src/styles/base.css` 为事实源：正文使用 `--font-body`（Segoe UI Variable Text → Segoe UI → Microsoft YaHei UI → Microsoft YaHei），展示标题与主导航使用 `--font-display`（Segoe UI Variable Display → 同一稳定回退）。中文逐字形回退到微软雅黑 UI；不把独立的 Segoe UI Light 字体放进正文回退链。全局 `user-select: none`（输入框除外）。
- 全软件字号与字重由同文件的 `--type-*`／`--weight-*` 按角色集中定义，组件不得另写数值字重或独立字号。主导航为 25px／300；收藏、播客、设置与小屏的页面分类为 18px／400；对象详情、资料库、播客设置、播放列表分类及阅读标签为 14px／400。选中态以颜色和强调线表达，不改变字重。页头高度由 `--app-header-height` 定义，普通内容页与 quickplay 共用同一剩余高度计算。
- 页面标题 38px／250（≤1000px 窗口收至 32px），区块标题 24px／300，子标题 18px／400，对话框标题 28px／300；突出媒体名称 16px／400，正文与普通列表 14px／400，常规控件 13px／400，辅助信息 12px／400。语义强调使用 600，次级信息优先用 `--muted` 区分，不降低字重。栏目引题与角标使用独立的 11px 角色。
- quickplay 全景分组、正在播放的媒体身份与背景大字使用各自的流式展示字号；展示标题保持负字距与轻字重，背景大字用 200。封面缺失符号、图标内跳转数字使用独立角色，不作为功能性正文的字号。歌词保留用户选择的小／标准／大及原有主副行字号比例，设置和搜索面板沿用通用控件／标题层级。小屏当前曲名使用 18px／300，列表与导航沿用同级角色。
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

光焰形状由真实频段包络与瞬态决定，峰位、宽度与局部亮度应随乐段变化，不能用固定中央山形或静音兜底动画覆盖信号。普通页面与播放条共享背景，底部控制区透明、无上边线；quickplay 与收藏背景在下沿自然淡出。保持底部低暗光焰与控制区可读性；画布尺寸以 `src/styles/now-playing.css` 为准，普通页面亮度与层级在 `src/styles/base.css`。色彩连续性、DSP 参数及回归场景统一见 [播放与正在播放视觉](engineering/playback-visuals.md)。

## 3. 动效语言

### 3.1 页面转场（`src/motion/pageTransition.ts`）

- 平级页 pivot：沿导航序（quickplay → collection → podcasts → settings）方向感知滑入滑出；nowPlaying 在其上 push/pop。
- 顶层导航由 `SurfaceTransition` 执行成对的静态画面退场与目标页面入场；收藏、播客与 quickplay 的内容交接统一消费 `BROWSE_MOTION`，设置消费 `NAVIGATION_MOTION`，快速反向从当前帧接续。具体编排与清理规则见 [动效系统](motion-system.md)。
- **不要给整页根节点加 scale**——会让页面标题产生垂直漂移（两次实测教训）。纵深感属于小元素，不属于页面。

### 3.2 列表级联（feather）

- 未托管的首次展示使用 `motion-feather-in`：位移 drift-m + `scale(0.96→1)` + 透明度，`backwards` 填充（`both` 会永久压住 transform，禁止）。页面交接不叠加该动画。
- 首次展示的逐项错峰用 `--stagger`，步进 24ms、封顶 144ms；quickplay 首次分组错峰 60ms（0/60/120/180）。浏览交接及返回 quickplay 的封面节奏统一见动效系统。
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
| `Select` | 单选下拉原语；`option` 子元素只作数据，以中文 `aria-label` 命名，受控值经 `onValueChange` 更新。触发器与展开面板共用深色、粉色选中标记和焦点样式；播客筛选、分组、列表、设置及音乐智能列表统一使用。方向键／Home／End 选择活动项，Enter／空格确认，Escape 取消，Tab 或外部点击收起；打开时不自动提交新值 |
| `Dialog` | 深色确认/表单对话框壳：遮罩 + kicker/标题 + 可选右侧动作行，Escape/点遮罩取消、`busy` 时锁定；保留 `playlist-dialog` 基类让 swivel 入场与 Presence 退场继续生效。例外：`SmartPlaylistDialog` 是编辑器表面（不走壳，底部动作用 `Button`）；正在播放的保存列表对话框是刻意的浅色主题，保持独立 |
| `tiles/`（`Tile` / `FlipTile` / `CycleTile` / `IconicTile` / `MosaicFrames`） | Metro 磁贴系统（`tiles.css`）：`Tile` 提供统一倾斜按压与裁切表面；`FlipTile` 有 peek/flip 两种背面揭示；`MosaicFrames` 是 People-hub 封面墙；`CycleTile` / `IconicTile` 是备料模板——暂无消费方，接入前不算「已在用」。quickplay 固定项由 `QuickplayPinBoard` 编排，宽磁贴与播客用 peek，其余音乐磁贴用 flip；小磁贴静态显示 |
| `Cover` | 唯一封面渲染入口：`artPath`（本地文件）与 `src`（已解析 URL）二选一；默认音乐封面类（accent-index 渐变占位 + 首字母），`className`/`fallback` 供上下文适配——播客经 `PodcastArtwork` 适配器（`podcast-artwork` 类 + 字符/Podcast 图标占位） |
| `CollectionTrackList` / `CollectionAlbumTile` | 收藏页共享歌曲行与专辑封面项。歌曲行统一选择、键盘定位、播放来源、当前曲目和收藏状态；专辑的选择按钮与悬停播放按钮互为独立控件，避免嵌套按钮 |
| `MetroLoader` | 唯一加载指示（见 §3.5） |
| `EmptyState` | 页面级空态（空曲库：字标 + `Button` solid xl 动作）；区块级空态/加载用播客 `primitives.tsx` 的 `PodcastEmpty` / `PodcastLoading`（`MetroLoader` + 延迟淡入）。不写解释段落 |
| `ContextMenu` / `PodcastEpisodeContextMenu` | 右键菜单；swivel 入场；系统右键全局抑制 |
| `InfoPanel` | 按实体范围管理文件与补充资料；头部为封面／艺术家图与类型标识，正文按实体种类给出归属、年份、流派、时长等可用字段，歌曲另有“文件”分组，缺失字段省略；补充资料的长文本（介绍／歌手简介）整行展示，艺术家不借用歌曲专辑封面；无图艺术家打开面板时自动在线查找一次，仅采用精确匹配，失败保持静默并保留手动查找；独立焦点隔离，右缘 swivel 入场；面板内部不得再使用 `<section>`（外壳选择器限定直接子元素） |
| `PlaylistDialog` / `AddToPlaylistDialog` / `MetadataEditDialog` / `MetadataSearchDialog` / 播客确认框 | 全部建在 `Dialog` 壳上，动作行用 `Button`；遮罩淡入 + 盒体 rotateX 下沉入场由壳的基类继承 |

`Dialog`、资料面板与智能列表编辑器共用 `useModalFocus`：打开后焦点留在浮层内，关闭后返回有效入口。浮层交接或嵌套期间以共享计数维护背景 `inert`，前一浮层退场不能解除后一浮层的隔离。

`Select` 面板通过 WebView2 的 Popover 顶层脱离内容裁切，DOM 仍留在所属浮层内；根据窗口可用空间向上／下展开并限制宽高。焦点留在 combobox，以 `aria-activedescendant` 指示活动项；第一次 Escape 只收起下拉，之后才关闭所属对话框。面板退场走 Presence，减少动态效果由 `motion.css` 统一收敛。长选项在面板中换行，触发器省略并提供完整提示。

智能列表编辑器在标题栏与播放条之间居中，最大 1000×560px，窄窗口保留外侧边距并收缩；模板、规则、预览各自滚动，保存／取消固定可见。保留全部规则和预览功能，不通过缩小控件字号或隐藏预览换取空间。几何以 `playlists.css` 为准，`--dialog-offset-y` 设为零，仍复用共用弹窗进退场。
| `Titlebar` / `AppHeader` | 无边框窗口 chrome 与 pivot 导航；选中态只变色 + 下划线，**不做位移** |

### 4.2 播放 chrome

- `PlayerBar` / `PodcastPlayerBar`：底部 74px 常驻；媒体源二选一，互斥。
- `TransportControls`、`PlaybackProgress`：极简线性控制；图标切换用 `motion-icon-swap`，收藏确认用 `motion-confirm`。
- 播客倍速以 `PodcastRateButton` 直接循环常用速度，当前值即入口，底栏、全屏与小屏共用。睡眠独立打开设置；不使用旋钮或倍速按钮阵列。
- 正在播放的简介、节目、章节、转写、书签在封面旁原位阅读，阅读区单独滚动，控制区常驻。
- 节目／单集正文复用安全段落排版，保留空行、列表、标题与可选择文本。

### 触屏输入

- `CollectionTrackList` 的触摸单点播放保留所在列表的播放来源；移动超过容差、指针取消或右键／长按菜单触发后不得播放。鼠标仍单击选择、双击播放，键盘激活直接播放；触摸产生的兼容双击事件不重复启动播放。
- 触摸输入沿用原有排版、尺寸和控件，不按设备触摸能力切换密度。`useTouchInteractions` 在应用根节点接入共享手势守卫：移动、实际滚动、多指或取消后抬手不执行点击，惯性滚动刚停止时的首次触摸只停止滚动；鼠标与键盘仍按原语义激活。
- 歌曲、专辑、艺术家、播放列表与首页媒体项，以及播客单集／继续收听／待播通过 `data-touch-menu` 长按打开已有实体菜单，时长复用 `TILE_MOTION.longPress`；移动或滚动取消，抬手不播放／进入详情，原生长按菜单不重复打开。独立行内动作不触发父实体长按，固定磁贴保留已有长按编辑。
- 音量复用原有文字和滑杆：轻触文字聚焦可见滑杆，沿用原有展开样式，外部触摸或 Escape 收起；在音量文字上左右拖动直接调节 0–100，适用于窄窗口隐藏滑杆的布局。直接操作滑杆、鼠标滚轮与键盘保持原行为，纵向移动、多指、取消／失焦清理文字拖动。
- 运行时验证入口为 `touchInteractions.test.mjs`、`collectionInteraction.test.mjs` 和 `transportControls.test.mjs`；浏览器检查默认／最小窗口与小屏下的音量、长按、滚动及混合输入，并对比修改前后的静态布局。

### 小屏模式

- `Titlebar` 在最小化按钮左侧提供“小屏模式 / 返回正常模式”。正常模式保留 Zune 4.8 布局，小屏使用 Zune HD 风格的纵向黑底、大号轻字重文字和真实封面；隐藏全局设置和最大化按钮。
- 小屏标题栏在模式按钮左侧提供“置顶窗口”图钉开关，开启后用主题色和实心图标标记，支持键盘操作。状态来自原生窗口，置顶与模式切换期间共同防重；回到正常模式时恢复进入小屏前的置顶状态，不跨启动记忆小屏置顶选择。
- `CompactPlayerView` 提供播放、音乐和队列。播放页不展示大导航和专辑名，只保留封面、曲名与一行艺术家／节目名；暂停时维持相同布局。音乐和队列从“更多播放选项”进入，浏览时显示“播放 / 音乐 / 队列”导航。音乐可浏览专辑、艺术家、歌曲与已有普通／智能列表，支持搜索、播放和收藏；队列沿用实际播放顺序。导入、编辑、下载与详细设置经明确入口返回正常模式。
- 音乐与播客共用 App 的主音频和现有播放动作。播客只提供当前单集、稍后听、15/30 秒跳转、倍速、下一集及待播选择，保留加载、缓冲和失败重试反馈；不加入音乐收藏或音乐队列。小屏不挂载音乐拼贴、歌词编辑器或可视化采样。
- 窗口默认直接使用常规最小 220×360，最大 360×600（逻辑像素），以掌机体量为目标；几何以 `src-tauri/src/window_mode.rs` 为事实源，默认值与最小值共用常量。当前屏幕工作区不足时适配可用高度。返回恢复原尺寸、位置和最大化状态，显示器移除时回到可见位置；窗口模式不写音乐或播客数据库。
- “播放”信息可滚动，底部进度、播放与切歌常驻。收藏／稍后听、音量、随机／循环或播客倍速／下一集由“更多播放选项”展开，复用 `Presence`，打开后聚焦音量，Esc 关闭并返回触发按钮，外部点击与焦点移出收起。长标题换行，列表标题省略并提供完整提示；封面随可用高度缩放。
- 内容区横向拖动或滑动切换相邻标签，详情中右滑返回并恢复来源焦点；到两端停止。纵向滚动、搜索框文字选择和已取消的手势不导航，拖动不触发列表播放。Tab 与方向键切换浏览导航，Ctrl+F 搜索音乐，Esc 依次关闭播放选项、清除搜索、返回详情、回到播放；回到播放时焦点落到仍可见的内容区。内部浏览复用 `useCollectionPanelMotion`，动效方向跟随切页／返回，键盘和 reduced-motion 不播放位移动效。
- 验证默认／最小正常窗口与 220×360 小屏，覆盖播放中切换、暂停布局稳定、最大化恢复、置顶开关及退出恢复、队列顺序、空库、长文案、播客错误、键盘焦点、展开控制、横向滑动和减少动态效果。运行时测试入口为 `tests/compactPlayer.test.mjs`；原生窗口测试为 `cargo test --lib window_mode::tests`，实际尺寸、置顶行为和播放连续性仍需真实 Tauri 验证。

### 4.3 页面级

- 页面通过 `requestNavigation` 接入统一页面过渡；不再新增独立页面级入场关键帧。正在播放沿用舞台与封面 FLIP 的编排。
- 顶层导航立即响应，键盘与鼠标共享方向，快速连切从当前画面接续。quickplay 返回恢复表面并播放页面交接，磁贴翻入只在首次展示；收藏与播客共用内容控制器，少量语义区域负责横向运动，首屏条目只错峰淡入；两边分类导航与搜索保持原位，播放列表仅右侧内容过渡。滚轮接续、输入打断与参数见 [动效系统](motion-system.md)。
- 音乐收藏由 `CollectionView` 统一组织分类、搜索、对象详情与返回。分类索引只保留一行分类／搜索和数量，不重复大标题。`CollectionArtworkBackdrop` 使用曲库或当前浏览对象的真实图片形成低对比背景，不跟随当前播放，不放幽灵字；详情、歌曲、搜索及播放列表进一步降低背景强度。`buildCollectionBrowseBackdropScene` 去重并限制最多六张图片，复用 Canvas 缓存、交叉淡入和减少动态效果规则。具体排版见 `collection.css`、`collection-details.css`，信息和关系契约见 [收藏信息架构](collection-information-architecture.md)。
- 艺术家索引用紧凑的两列媒体条目，真实艺术家图优先，否则用标明“作品封面”的本地封面；图片、名称、数量共用详情入口。艺术家详情先展示对象身份与本地作品总览，再用内部标签浏览全部专辑／歌曲；头部右侧为带「简介」标识的简介区，缺失时整块省略，预览限五行，长简介经限高滚动的对话框展开，窄窗口下移到头部整行。专辑艺术家与逐曲署名区分，合辑显示参与关系，不按斜线拆分原始署名。
- 专辑详情将封面、艺术家关系和本地曲目放在同一主滚动区，头部复用同一「简介」区展示专辑介绍（缺失省略、预览限五行、长文经限高滚动的对话框展开，介绍经资料面板在线查找或编辑写入）；多碟分组、排序沿用本地标签。歌曲详情提供所属专辑、同专辑其他歌曲及实际收录的普通／智能列表。“其他专辑”等补充区块为空时整体省略，未知时长不伪造。
- 播放列表保留左侧列表索引、右侧标题与歌曲表格。封面取真实歌曲封面的单图或四格组合，缺图显示类别图标。仅在全部曲目时长已知时显示总时长，空列表禁用播放；普通／智能列表的创建、规则、轮换、排除、固定和 SmartDJ 沿用既有流程。
- 歌曲表正文为 400 字重，歌曲主体单击选择、双击或 Enter/Space 播放，上下及 Home/End 只移动选择和焦点；独立的关系链接、查看歌曲、喜欢不触发播放。艺术家概览用紧凑歌曲行，其余歌曲表保留关系列与时长。专辑索引主动作进入详情，独立播放按钮支持鼠标与键盘。
- 收藏入场只处理恢复滚动后的可见内容。歌曲表头与正文作为一个区域横向交接，歌曲行只按阅读顺序错峰淡入，保持列对齐和行距；艺术家条目与专辑封面保留纵向展开。播放列表左侧索引与新建按钮保持稳定，右侧标题与歌曲内容负责过渡。页面与分类共用 `contentEntrance.ts`，不为整库重播 CSS feather；键盘和滚动从当前帧收稳，减少动态效果时立即显示。参数与生命周期见 [动效系统](motion-system.md)。
- 普通列表允许从菜单移除歌曲，以及指针拖动、Alt+上下或菜单调整顺序；拖动复用 `usePinDrag` 的指针捕获，列表内释放提交，Esc／失焦／移出列表取消。喜欢列表使用喜欢开关，智能列表使用规则与排除，不能混用改序或移除语义。任何列表编辑都不改写已交给播放器的队列快照。
- 对象详情共用浏览历史，返回／前进恢复查询、筛选、内部标签、选中行、滚动锚点与焦点。quickplay 更多菜单、正在播放的艺术家／专辑进入相同详情并可返回来源；对象无法对账时显示不可用，不能自动跳到第一项。右键及 Shift+F10 打开对应实体菜单，菜单支持方向键、Home/End 和 Esc。
- quickplay：保留 Zune 横向全景与分组，固定区采用 WP 8.1 的小／中／宽磁贴，兼容既有大磁贴。网格以小磁贴为单位，中为 2×2、宽为 4×2、大为 4×4；组宽随内容增长，窄窗口不强留半屏空白。
- 首页底部使用悬浮短滚动条，不另列一排重复的分组导航。仅在滚动时显现、停止后淡出；拖住滑块或键盘聚焦时保持可操作，内容全部放得下时禁用并隐藏。背景大字、底色和内容按不同速度随真实滚动位置移动，停下浏览后不自行漂移。“继续播放”封面按区块可用高度缩小，为曲名和艺术家留出完整空间。
- 播放历史用等高双列展示小封面、曲名和艺术家，不再单独放大第一项；按真实最近播放顺序最多显示 12 首，排除当前曲目、重复及已移除记录，不用曲库内容补满。窄窗口在区块内纵向滚动；整行支持播放、键盘激活和右键操作，长文字保留省略与完整提示。
- 固定区由 `QuickplayPinBoard` 负责：编辑按钮、长按或 F2 进入，选中一块后显示取消固定与缩放角标；拖动采用指针捕获，磁贴跟随指针并预览重排，在固定区内释放后保存。`utils/homePinLayout.ts` 按六行、列优先的稀疏网格及四种尺寸模拟插入后的布局，用保留抓取偏移的位置选择最近的可达插入点，混排空位也可放入，不将所有空白当成追加到末尾。落点计算独立于预览 FLIP 的中间矩形，拖回原位撤销预览。移出固定区松手、Esc、指针取消或窗口失焦均取消当前拖动，不改持久顺序。Alt+左右移动、Alt+上下缩放、非拖动时 Esc 完成；编辑时不触发播放。
- 编辑态选中磁贴浮起放大，其余磁贴收缩退暗；动态内容和播客更新角标共用稳定表面，切换编辑宿主时不重置该层过渡。拖动中隐藏原位表面，释放后由真实磁贴接续浮层当前位置再落位；重排和缩放保持连续。鼠标选择用层次表达，键盘焦点保留可见描边。具体参数与 reduced-motion 行为见 [动效系统](motion-system.md)。
- “外观”用 `Dialog` + `Presence` 提供尺寸、封面／纯色背景和动态内容开关。中及以上尺寸正面保留名称，小磁贴保留封面或图标，按钮始终有稳定的可访问名称；播客小磁贴可显示未听数。外观与顺序按 [持久化规范](engineering/persistence.md) 保存。
- `FlipTile` 揭示真实歌曲／专辑／播放列表信息或播客最新单集；宽磁贴与播客正反面板一起滑动，背面继续使用封面或所选纯色，文字靠下呈现。悬停或键盘聚焦保留展示面，正在翻转的这一段先收稳，背面停留计时暂停，离开后继续剩余时间；编辑、隐藏、离开可视区、关闭动态或 reduced-motion 才停转并归位。`MosaicFrames` 只替换尚未显示的封面，处理中的磁贴暂停自动替换。
- 磁贴封面按实际显示框居中裁切，宽磁贴显示封面中央区域，拼贴每格按各自边界裁切；封面的 Grid 轨道用可收缩的边界，图片固有尺寸不撑大显示框。
- now playing：拼贴背景 + 光焰 + 歌词模式同空间切换；chrome 无操作约 5s 进入沉浸态。
- 播客：`src/views/podcast/` 按 screens/components 分层，加载态全部走 `PodcastLoading`（内含 `MetroLoader`）。
- 播客资料库的节目排序复用 `Select`，与分组筛选及新建／编辑分组排在「已关注」标题旁的工具区；空间不足时自然换行，长分组名省略并保留完整提示。资料库子标签采用第三级导航字号，具体几何以 `podcasts.css` 为准。
- 播客 hover 语言（已登记）：封面卡用第 4 级（封面降 opacity、轻抬 2px），列表行只做文字即时提亮，均无行级背景，详见 `design/motion-system.md` Hover 反馈分级。
- 播客文本动作条（单集详情 `.podcast-detail-actions`、下载/待播批量条）：hover 纯白、`.primary` 实心 accent、`.danger` 文本红，是播客页面级语言，不走 `Button` variant；新增播客行内动作沿用同一模式。
- 播客正在播放的队列面板与睡眠 popover：进退场规则就近放在 `podcast-now-playing.css`（token 时长 + `Presence` 生命周期与共享表一致），reduced-motion 仍由 `motion.css` 统一块收敛。原位阅读使用 content 档的短入场，不切换整个舞台，减少动态效果时直接显示。
- 发现页最近搜索是输入框聚焦时的建议层，不占页面行；进退场走 `Presence` + `motion.css` 的 context-menu 表，reduced-motion 仍由统一块收敛。
- 播客分区、节目／单集详情与资料库／播放列表子标签复用收藏的 `browseTransition.ts` 和 `useBrowseEntrance`，只过渡内容区域，分区与搜索栏保持稳定。正式页面禁用旧 CSS feather，异步内容到达、进度刷新和普通数据更新不重播动画；参数与验证见 [动效系统](motion-system.md)。
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

收藏页验证覆盖播放列表→歌曲→专辑→艺术家→其他专辑的连续浏览与返回、搜索筛选恢复、入口焦点、播放与喜欢独立性、普通列表编辑和智能列表行为、元数据迟到响应隔离、空关系、长名称及长列表。默认与最小窗口检查表头、滚动和焦点，减少动态效果时关闭位移与倾斜。入口为 `tests/collectionEntities.test.mjs`、`tests/collectionInteraction.test.mjs`、`tests/collectionJourney.test.mjs`；布局与原生播放连续性仍需对应真实流程检查。
