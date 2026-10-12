# Zone 动效系统：Alive in Motion

本文档是 Zone 动效系统的说明书：设计原则、token 体系、`src/motion/` 内核 API，以及新组件接入动效的标准做法。改动动效前请先读这里；改变约定或 API 时同步本文，全局规则或入口变化才更新根目录 `AGENTS.md`。表中数值是当前实现，以 `src/motion/tokens.ts` 为事实源，可按任务需求验证后调整。

## 设计原则

动效的存在是为了让界面可理解、有生命感、帮助用户建立空间心智模型——不是为了好看。六条工作原则：

1. **节奏服务关系**：按压和浮层反馈使用短时长；页面和内容接续允许更长的减速尾段。响应立即发生，不把缩短时长或取消动画当作流畅度的替代。常规退场比入场更快更轻。
2. **物理感**：惯性、减速，不是生硬的线性运动。可打断的动画从当前值/当前速度接力，不从头重播。
3. **延续性**：元素在页面之间有来处和去处（成对出入场、封面 FLIP），不是完全断裂。
4. **分级幅度**：重要内容动得更明显，次要内容更克制——位移用 `--motion-drift-l/m/s` 三档区分（封面/标题大、列表项小）。
5. **服务内容**：动效不抢内容风头；内容在动效期间保持可交互（WP7 feather 传统）。
6. **有目的**：每个动画只做三件事之一——反馈（press/confirm）、引导（stagger 入场）、解释关系（pivot 方向、FLIP）。

减少动态效果（`prefers-reduced-motion`）是一等公民：所有空间动效有收敛路径，见下文「reduced-motion 约定」。

## 系统分层

```text
src/motion/tokens.ts          唯一事实源（时长/缓动/幅度/弹簧预设），启动时注入 :root CSS 变量
        ↓
src/styles/motion.css         原语层：feather 入场、页面出入场、浮层退场、按压/确认反馈、唯一 reduced-motion 块
        ↓
src/motion/*.ts               内核：弹簧/补间/动画器/FLIP/Presence/页面过渡表（纯 TS，node 可测）
        ↓
组件接入                       App 导航状态机、浮层 Presence、封面 FLIP、canvas rAF
```

## Token 体系（`src/motion/tokens.ts`）

**不要在 CSS 里硬编码时长和缓动曲线**；也不要在 CSS 里重新定义这些变量——它们由 `applyMotionTokens()`（`src/main.tsx` 启动时调用）注入。

| CSS 变量 | 值 | 用途 |
| --- | --- | --- |
| `--motion-instant` | 80ms | reduced-motion 下的近似即时反馈 |
| `--motion-press` | 110ms | 按压回弹、图标切换 |
| `--motion-micro` | 160ms | 浮层过渡、常规交互退场 |
| `--motion-content` | 220ms | 内容出现、feather 入场 |
| `--motion-page` | 260ms | 页面入场、舞台溶解 |
| `--motion-browse` | 640ms | 收藏与播客内容区域的轻移收稳 |
| `--motion-browse-reveal` | 180ms | 文本区域整体显现、封面逐项显现 |
| `--motion-chrome` | 700ms | 正在播放页 chrome 隐没（刻意慢） |
| `--motion-cycle` | 800ms | 慢速环境循环（cycle 磁贴交叉淡化） |
| `--motion-loader` | 4500ms | 长循环加载器（Metro 轨道），不是过渡时长 |
| `--motion-ease-standard` | (0.23,1,0.32,1) | 强 ease-out，默认交互曲线 |
| `--motion-ease-entrance` | (0.18,0.88,0.24,1) | 入场专用 |
| `--motion-ease-exit` | (0.55,0.06,0.68,0.19) | 加速离场，**退场专用** |
| `--motion-ease-emphasis` | (0.175,0.885,0.32,1.275) | 轻微过冲（tilt 按压） |
| `--motion-ease-dissolve` | (0.4,0,0.6,1) | 正在播放闲置隐藏的渐缓溶解 |
| `--motion-ease-browse` | (0.215,0.61,0.355,1) | 浏览内容的小位移减速 |
| `--motion-drift-s/m/l` | 8/22/48px | 位移幅度三档 |
| `--motion-stagger-step/max` | 24/144ms | 列表错峰步进与上限 |
| `--motion-feather-scale` | 0.96 | feather 入场起始缩放 |

TS 侧对应常量：`MOTION_DURATIONS`、`MOTION_EASINGS`、`MOTION_DRIFT`、`MOTION_STAGGER`、`SPRING_PRESETS`（`snappy` 近临界阻尼 / `gentle` 页面级 / `bouncy` 约 20% 过冲）。其中 `snappy` 是现役生产预设（共享封面 FLIP、quickplay 滚轮）；磁贴重排／尺寸调整的 FLIP 使用 `TILE_MOTION` 时长与 navigation 曲线；`gentle` / `bouncy` 仍是**备料预设**。

通用短时长原则用于交互反馈，不给分层编排、悬停等待、循环加载或音频 DSP 包络套统一上限。正在播放入场和 Canvas 收敛使用 `tokens.ts` 中的 `NOW_PLAYING_MOTION`，不要在组件中复制时长。

收藏、播客浏览及 quickplay 的页面交接共用 `BROWSE_MOTION`：内容区域横向位移 22px、640ms 用 browse 曲线减速收稳，透明度显现独立为 180ms，使用 dissolve 曲线从浅到明逐渐显现。向后一个分类／分区前进时，内容从左侧轻移到位；返回时镜像方向。区域同步移动，封面逐项按 46ms 步进显现，等待封顶 506ms，完整入场最迟 686ms 收稳。旧数据在原位用 80ms 淡出，不拖着旧文字长时间重叠；移动内容上的输入用 160ms 收稳。分类导航、搜索、数量和播放列表左侧索引不参加入场，也不提前加速右侧动画。进入播放列表时，旧页面像素副本静态裁切到右侧，不能盖住新左栏。顶层进入收藏／播客也委托同一内容控制器，内部导航接管时清除顶层旧画面，不叠加两层退场。quickplay 只动画可见内容分组，根节点、大字背景和视差底图保持稳定，不叠加整页与分组位移；返回首页不重播首次磁贴翻入。设置仍使用 `NAVIGATION_MOTION` 的页面编排；事实源均为 `tokens.ts`。

`contentEntrance.ts` 区分封面条目和文本列表：艺术家、专辑、播客节目及 quickplay 封面按阅读顺序从完全透明逐项显现，父区域只负责位移，避免双重淡入。含封面的区域中，标题和其他不包含封面的直属文字块独立显现并继承同一次区域位移；反向交接同时保留文字与封面的当前透明度。歌曲表格、播客单集和待播列表由区域整体显现，行本身不启动动画，捕获文字帧也不遍历读取歌曲行样式。歌曲表头与正文共用一个表格区域，播放列表右侧标题与歌曲放在 `.playlist-detail` 中共用一个内容区域，外层分隔线、左侧索引及新建按钮保持稳定。均匀歌曲行与规则网格每区测两个条目，按恢复后的滚动位置选取可见内容；分页播客与全景封面按实际矩形处理不同尺寸内容，最多 12 区、48 个选中条目。专辑网格的延迟渲染占位按封面实际宽度和两行文字预留高度，避免入场测量后塌缩、漏掉底边封面。不增加加载等待，不给屏外条目启动动画。

正在播放闲置隐藏是自动退隐的刻意例外：返回、队列、底部控制区共用 chrome 档 700ms 与 dissolve 曲线，在原位同步降低透明度；唤回用 content 档 220ms 与 standard 曲线，CSS transition 从中间值反向接续，不重新挂载或重播入场。歌曲信息不随闲置状态变暗。用户主动隐藏队列仍走 micro 档 Presence；reduced-motion 下两类过渡均收缩至 instant 档。暂停、焦点和操作中的计时保护见 [播放视觉规范](engineering/playback-visuals.md)。

`tokens.ts` 中的 `TILE_MOTION` 统一维护磁贴长按、首次更新、后续更新间隔、背面停留、peek／flip／单格翻面及入场错峰参数。当前首轮更新在可见后 18–42 秒就绪，翻面完成后等待 45–90 秒，封面墙单格替换完成后等待 24–48 秒，背面停留 5 秒。`tileScheduler.ts` 在同一窗口串行调度翻面与封面墙替换：一次只运行一个完整周期（含停留与翻回），完成后至少静置 4 秒；就绪时间只是最早开始时间，多块磁贴排队时会进一步推迟。已更新的磁贴恢复可见或完成互动后的周期采用后续间隔，不重播较短的首轮等待。小磁贴与关闭动态的磁贴不循环。

`useTileActivity` 区分是否可见与是否正在悬停／聚焦，编辑切换 DOM 宿主时重新绑定。`FlipTile` 在悬停或聚焦时取消尚未开始的更新；正在揭示或翻回的动画先自然收稳，背面停留保留剩余时间并暂停，离开后接续，不重置展示面。持有背面的完整周期保留串行调度席位直到翻回，停留期间没有计时器或空闲 rAF。进入编辑、不可见、关闭动态或卸载时释放排队及活动任务并归位。reduced-motion 下停止自动翻面和封面替换，重排直接落到终态。

每段翻面／滑动捕获真实内容，动画完成不按最新数组下标重新取图。`MosaicFrames` 预加载候选封面，边缘处交接后保持同一内容至落位；图片池长度变化在本段完成后调整布局。`CycleFrames` 同样按内容身份保留淡入与淡出两面，并接入磁贴串行调度、可见性、互动及 reduced-motion 守卫。父组件刷新只供应后续内容，不覆盖正在显示的面板。运行时回归见 `tests/tileInteraction.test.mjs`。

`PANORAMA_MOTION` 维护首页视差、拖动惯性和滚动条停留：背景大字和底色当前分别跟随横向滚动的 22% / 8%，最大行程 480 / 240px；底色平面按 token 扩展，平移时不露出边缘。`useQuickplayPanorama` 直接写 DOM transform 与滚动条位置，不用逐帧 React state；返回页面时在同一 layout effect 内恢复位置，不闪现滚动条。粗步进滚轮与拖动释放使用可打断的 `snappy` 弹簧；触控板横向输入、细小或带小数的连续输入、滑块拖动和键盘定位不叠加惯性。拖动释放将实际速度传入弹簧，不从零速度重启。短滚动条在最后一次位移后停留 700ms，再按 micro 档淡出；拖住滑块时不隐藏，键盘焦点由 `:focus-visible` 保持可见。页面隐藏或卸载时取消动画与显隐计时器，reduced-motion 下停止视差、即时定位并收缩淡出；没有持续空闲动画。

收藏的纵向滚动区与首页内部纵向列表通过 `useWheelScroll` 接入同一弹簧。`wheelScroll.ts` 使用信号启发式：行／页单位或纯纵向、整数且至少 `SCROLL_MOTION.coarseDelta` 的像素步进接续到累积目标，当前阈值 50px；这不是硬件识别。细小、带小数、斜向、Shift 与缩放输入保留原有归属。滚动边界保持列表归属，不启动空转；原生滚动定位、拖滚动条、键盘、指针按下、窗口调整、隐藏和卸载立即停止接续，reduced-motion 下保留原生滚动。滚动位置逐帧写 DOM，不用 React state。

`FlipTile` 的 peek 让正反两块完整面板沿同一进度向上滑动，以 2000ms 和 `(0.1,0.9,0.2,1)` 减速收稳；返回时将隐藏的正面放到背面下方，继续向上交接，完成后仅归位隐藏面板。封面和文字一起移动，背面沿用封面或所选纯色。整块 flip 与 `MosaicFrames` 单格翻面共用连续的 cubic 加速／减速进度，两半使用同一个计时，在侧面保持连续速度；单格在隐藏边缘同步交接已捕获的封面，然后继续落位。

编辑态通过稳定的 `.quick-pin-surface` 在 240ms 内将选中磁贴放大至 1.05，其余磁贴缩至 0.95、透明度降至 0.52，播客更新角标跟随同一表面。重排／尺寸调整使用 400ms FLIP；拖动中只显示浮起的磁贴，浮层从来源表面的当前缩放与透明度接续浮起。松手及取消均捕获浮层的可见表面矩形和透明度，真实磁贴补偿编辑态居中缩放，从该姿态用 500ms 落位；释放位置采用最后一次指针坐标。再次拖动先捕获当前动画矩形，避免从旧终点重启；键盘焦点仍有独立描边。reduced-motion 下取消位移和缩放，直接落位，保留选中与退暗提示。

其他已登记的当前编排：歌词加载呼吸 1.1s、歌词行移动的 `cubic-bezier(0.77,0,0.175,1)`、`TILE_MOTION` 中的 Lumia/Metro 校准组（flip 两半各 200ms、`MosaicFrames` 单格半翻 280ms、cycle 离场清理 900ms、quickplay 磁贴入场错峰 46ms 步进/460ms 封顶与 900ms 挂载窗口）。收藏封面播放／详情动作使用 `COLLECTION_MOTION.albumHoverDelay` 的 700ms 停留判断，随后以 press 档淡入，移出立即隐藏并停止命中。CSS 的延后 `visibility` 在等待期间保持按钮不可见、不可点击，移出取消等待、重入重新计时，不引入组件计时器或逐帧更新。`CollectionAlbumTile` 在键盘聚焦或按键时保持动作可见，直到焦点移出当前专辑，避免 Tab 交接时隐藏下一目标；鼠标选择清除键盘显现状态且不跳过等待。reduced-motion 保留停留判断并取消显隐补间。调整时检验对应交互与 reduced-motion，不将这些参数当成必须另行审批的永久限制。

## 内核 API（`src/motion/`）

- `math.ts` — `clamp` / `clampInt` / `lerp` / `smoothstep` / `easeOutCubic` / `easeInCubic`。所有 util 的统一来源，不要再本地重复实现（`visualizer` / `beatAnalysis` / `audioGlow` / `tiltPress` / `nowPlayingCanvas` / `lyricsMotion` 均已收编）。
- `spring.ts` — 半隐式欧拉弹簧：`createSpring(from)`、`advanceSpring(state, preset, target, dtMs)`、`springSettled(state, target)`。retarget 时把上次返回的 state（含 velocity）继续传入即得惯性接力。
- `tween.ts` — `cubicBezier(x1,y1,x2,y2)` 求值器；`MOTION_TWEENS` 是与 easing token 同源的预建函数。
- `animate.ts` — `animateValue({ from, to, spring? | tween?, onUpdate, onComplete })` → `{ cancel, retarget }`。全应用共享一个 rAF 循环，空闲自动停转；测试可注入假时钟（`_setAnimationClockForTesting`）。
- `flip.ts` — FLIP registry：`registerFlipSource / registerFlipElement(id, ...)`、`takeFlipSource(id)`（取出即删，>1s 过期）、`computeFlipDelta(source, target)`。
- `coverFlip.ts` — 封面共享元素飞行编排：`registerCoverFlipSource` 保存可见矩形与已解码图片；`playCoverFlip({ id, source, target, direction? })` 用 Canvas 快照和 Web Animations API 执行有限的 transform 飞行。入场文字在飞行期间显示，落位仅做短暂的轮廓交接，不等待图片重新解码或弹簧静止。`rememberCoverReturnTarget` 保存底部栏实际位置，`startCoverReturn` 在点击返回时起飞，与目标页面入场重叠；底部栏挂载后 `attachCoverReturn` 接管终点，不重播返程。仅在「播放条/quickplay 大封面 ↔ 正在播放曲目卡」链路使用；时长由 `NOW_PLAYING_MOTION` 统一管理。
- `presence.tsx` — `<Presence show exitDurationMs exitClassName?>`：show 转 false 时保留子树、挂退场类、超时卸载；`useLastNonNull(value)` 冻结关闭前快照供退场窗口渲染（退场窗口内 props 冻结不刷新，窗口应保持在 micro 档，不要拉长）。当前歌词设置面板和在线来源搜索面板也采用这条链路。
- `pageTransition.ts` — 顶层方向解析（pivot/push/pop）。`surfaceTransition.ts` 在导航意图提交时冻结旧画面，浏览页面只复制数据区并委托 `browseTransition.ts` 入场，分类及搜索始终保持原位；延迟加载通过 MutationObserver 等待实际内容挂载。非浏览页面保持页面运动，正在播放仍由舞台与封面 FLIP 负责。
- `collectionPivot.ts` — 收藏分类、详情和历史的方向解析及快照准备包装；入场直接复用 `playBrowseTransition`。`useCollectionPivot` 连接浏览 revision；收藏详情标签与播放列表选择复用 `useBrowsePanelMotion`。
- `browseTransition.ts` — 收藏与播客共用的数据区快照、语义区域位移、可见条目显现、快速反向与输入收稳；同一页同时只有一个入场控制器，子面板接管时释放上一轮效果。`useBrowseEntrance` 统一 reduced-motion、延迟挂载和卸载清理；播客页壳在 screen 改变前准备快照，资料库和播放列表子标签只接管内容面板。
- `surfaceSnapshot.ts` — 有限、inert 的静态画面复制，冻结当前动画／Canvas、保留根及子滚动位置；歌曲行、连续浏览名称与封面网格仅复制可见范围及少量边缘行，流派中不可见的艺术家分组只保留原高度。等行距和规则网格以两次条目测量定位，留白保留滚动与列对齐；旧 React 生命周期正常卸载。
- `contentEntrance.ts` — 两类浏览共用的首屏条目选择与透明度显现；展开期间暂时停用滚动锚定，结束后恢复。快速反向复用快照中的稳定条目标识及透明度，已显现条目不重新隐藏。
- `useReducedMotion.ts` — `useReducedMotion()` hook，JS/rAF 侧统一入口。

## 接入指南

### 给新列表/内容块加入场

把元素类名加进 `motion.css` 的 feather 选择器组即可（`animation: motion-feather-in var(--motion-content) ... backwards; animation-delay: var(--stagger, 0ms)`），并在 stagger 表里补 `:nth-child` 行。重要内容需要更大幅度时，在该元素的规则里设 `--motion-drift: var(--motion-drift-l)`。

收藏和正式播客页通过共享控制器调用 `contentEntrance.ts`，关闭旧 CSS feather；普通数据、进度、搜索结果刷新不触发新的入场。新增同类列表维护可见区选择器、歌曲的稳定 `data-collection-anchor` 或播客的 `data-podcast-episode`／`data-podcast-show`，补充运行时测试。独立浮层和其他内容仍可使用 CSS feather。

### 给新浮层加入场 + 退场

- 入场：CSS `transition` + `@starting-style`（参考 `.context-menu`）。
- 退场：渲染侧用 Presence 包裹条件渲染：

  ```tsx
  const dialogElement = dialog ? <MyDialog ... /> : null;
  const lastDialogElement = useLastNonNull(dialogElement);
  <Presence show={dialogElement !== null} exitDurationMs={MOTION_DURATIONS.micro}>
    {dialogElement ?? lastDialogElement ?? <span style={{ display: "none" }} />}
  </Presence>
  ```

  再在 `motion.css` 补一条 `.motion-exit .my-dialog { animation: ... var(--motion-micro) var(--motion-ease-exit) both; pointer-events: none; }`（`.motion-exit` 挂在 `display:contents` 包裹层上，必须用后代选择器）。退场位移约为入场的一半、方向与入场呼应。

### 数值/物理动画（JS 驱动）

用 `animateValue` + `SPRING_PRESETS`，不要手写 setInterval/setTimeout 补间。逐帧回调里直接写 DOM（`element.style`），**不要用 React state 驱动逐帧进度**——这是本项目验证过的卡顿根因（歌词逐词填充、可视化都走这条铁律）。

### 共享元素连续（FLIP）

1. 源侧在交互触发时（元素仍在布局中）`registerFlipElement(\`kind:{id}\`, element)`。
2. 目标侧挂载时 `useLayoutEffect` 里 `takeFlipSource(id)`，命中则播飞行编排（参考 `coverFlip.ts`），未命中回退普通入场。
3. 两侧都要用 `useReducedMotion()` gate；卸载 cleanup 必须 cancel 动画并移除克隆。

封面链路使用 `registerCoverFlipSource` 携带已解码图片，缺图或未加载时回退普通入场。返程由 `coverFlip.ts` 的有限飞行控制器跨页面持有，正在播放页卸载只清理自己的入场，不取消已开始的返程。快速反向从当前克隆矩形与 Canvas 像素接续，不重读可能已换源的原始 `<img>`；底部栏重挂载时仅在布局变化后修正一次终点，不逐帧追踪布局。目标封面换源时取消旧飞行，避免旧克隆遮盖新内容。完成、取消、窗口尺寸变化、文档隐藏或减少动态效果切换时，统一移除克隆并恢复真实封面。图片请求与播客背景快切的运行时回归见 `tests/coverSwitchRuntime.test.mjs`。

### 页面导航

不要直接 `setPage`——走 `requestNavigation`，同步记录最新目标并立即挂载，不等待退场。旧画面复制为 `aria-hidden`、inert、禁止交互的有限静态层，只冻结现有 Canvas 像素和动画帧，不保留旧 React 生命周期；最多一层页面退场，完成后移除。快切从当前帧继续退场；在退场窗口内返回原页面时，从它当前的可见帧滑回。键盘和鼠标共享方向与编排，Ctrl+F 仍在首帧聚焦。窗口调整、隐藏、卸载和 reduced-motion 开启立即释放所有效果与复制层。quickplay 返回恢复滚动和视差位置并播放页面过渡，磁贴翻入仅在首次展示。收藏／播客只由数据区负责位移；内部切换接管当前内容，导航不继承父级动画。

### Hover 反馈分级

全应用的 hover 反馈按内容类型对号入座，不要自创新数值：

1. **行 hover**（列表行、设置行）：`background: rgba(255,255,255,0.06)` + 主文案提亮，过渡 `var(--motion-micro) var(--motion-ease-standard)`，**无位移**——hover 缩进（padding-left 动画）动的是布局属性，禁止。
2. **封面 hover**：`transform: scale(1.02)` + `filter: brightness(1.08)`；transform 走 `var(--motion-content) var(--motion-ease-standard)`，filter 走 `var(--motion-micro) var(--motion-ease-standard)`。刻意例外：`.album-cover-wrap` 悬停压暗到 `brightness(0.72)`，是为配合播放按钮浮现的设计，保留。
3. **按钮/图标 hover**：只变色/变背景，`var(--motion-micro) var(--motion-ease-standard)`。
4. **播客封面卡 hover**（已登记）：作用于 `.podcast-artwork` 本身，卡整体不动——发现页节目卡封面 `opacity: 0.8` + `translateY(-2px)`，资料库节目列表只降 `opacity: 0.78`；过渡在封面元素上（opacity/transform 各走 micro 档 standard）。不使用音乐封面的 scale+brightness：播客卡是「节目」，封面压暗轻抬即可，不要放大。

播客列表行（单集、继续收听、搜索历史）**刻意不做行级背景 hover**：密集文字列表以主文案即时提亮（→ `#fff`，无过渡）为全部反馈。新增播客列表行沿用这条；需要更强 affordance 时在行内放按钮，不要给整行加背景或过渡。

transition/animation 的缓动一律用 token，禁止裸 `ease` 关键字（唯一例外：`lyrics-source-search` 这类 `ease-in-out` 无限循环指示器）。

### 按压反馈

- 普通按钮的 `:active` `scale(0.97)` 由 `Button` 原语（`controls.css`）自带；播放控制、标题栏与播客正在播放 chrome（返回/走带/倍速/睡眠触发、`.podcast-play-action`）沿用 `motion.css` 按压组。
- 磁贴面的 3D 倾斜按压全应用只有一条规则：`motion.css` 的 `.tilt-pressed`（±10°、`scale(0.94)`、`perspective(600px)`，Lumia 校准）。角度由 `tiltPress.ts` 按按压点写入 `--tilt-rx` / `--tilt-ry`；reduced-motion 在统一关停块里清零。新增倾斜面挂 `tiltPressDown` / `tiltPressClear` 即可，不得在页面 CSS 里另写几何。

## 守则（Do / Don't）

- 时长/缓动只用 token；新增档位先加进 `tokens.ts` 再用。
- 常规交互使用 `transform` / `opacity`，避免在交互路径上引入布局属性动画（width/height/top/left）。**已登记的例外**：`.zune-volume` 音量条悬停展开（width，`player.css`）；新增布局属性动画需记录必要性并验证性能。已有亮度/模糊细节与 Canvas 媒体背景按各自规范验证，不把 transform/opacity 偏好解释为禁止其绘制。
- 常规交互退场 ≤ 入场时长，且统一走 `--motion-ease-exit` 加速曲线；正在播放的自动闲置退隐使用上文登记的缓慢溶解。
- 媒体时钟驱动的进度（歌词、播放）用 rAF 直读时钟，不叠加 CSS 补间。
- 不要引入与内容无关的无限装饰动画；加载反馈与正在播放媒体背景有明确用途，分别遵守加载组件规范与 [播放视觉规范](engineering/playback-visuals.md) 的停转规则。
- 启动加载反馈只做透明度显现，等待与显现时长分别消费 page／micro token；使用文档时钟接续入口分块和资料库恢复两个阶段，减少动态效果时直接显示静态 Metro 五点。不增加启动动画的最低停留时间。
- 每帧音频数据走 `visualizerBus.ts` 单槽总线，不走 React state/props；正在播放的封面转面与色场使用独立环境时钟，暂停、隐藏及减少动态效果仍按播放视觉规范收敛停转。

## reduced-motion 约定

全项目只有一个 `@media (prefers-reduced-motion: reduce)` 块：`src/styles/motion.css` 末尾。策略：入场/反馈动画 `animation: none` 落到终态；过渡压到 `--motion-instant`；空间变换（tilt、歌词缩放/模糊、长音拉伸）清零；**退出不留下静止窗口**——Presence 退场使用短的纯透明度淡出，卸载经 `resolveExitDurationMs` 收缩到同一 instant 档；页面导航直接挂载。新增带动效的组件时把选择器补进清单；JS/rAF 侧用 `useReducedMotion()` 关闭漂移/FLIP/滚轮惯性等连续运动。普通页面底部光焰与正在播放 Canvas 收敛后停止连续 rAF，音频采样也停用；播放中的光焰用固定低亮静帧，暂停或静音后清空，不播放伪音频动画。

## 测试与验证

- `tests/motion.test.mjs`：内核行为（弹簧收敛/过冲/惯性/高频 retarget 时序、补间求值、动画器、FLIP 数学、页面过渡表、token 完整性）。新增被测模块时同步 `tsconfig.test.json` 的 include，跨模块导入带 `.js` 后缀。
- `tests/coverFlip.test.mjs` / `tests/coverFlipBehavior.test.mjs`、`tests/visualizerBus.test.mjs`：FLIP 接线与运行时行为、可视化总线守卫。
- `tests/reducedMotion.test.mjs`：reduced-motion 下退出淡出与 JS 生命周期的同步守卫。
- `tests/lyricsSettingsUi.test.mjs` / `tests/lyricsDisplay.test.mjs`：歌词设置面板的 Presence 接线、显示偏好持久化和字号归一化。
- CSS/结构守卫（`nowPlayingCss.test.mjs` 等）会因类名/编排变化失败，按新结构同步，不放宽语义。
- `tests/tileInteraction.test.mjs`：真实磁贴组件的 StrictMode 生命周期、两块 peek 面板的连续位移、悬停／聚焦保留展示面与剩余停留、揭示及翻回期间互动不跳帧、多磁贴与封面墙串行更新、隐藏／编辑／reduced-motion 停转与恢复，以及长按、混合尺寸空位拖动、释放后接续落位、键盘和外观设置行为；`tests/tileScheduler.test.mjs` 验证同刻就绪、完整周期互斥、静置间隔及取消清理。
- `tests/panoramaBehavior.test.mjs`：首页分组与视差边界、滚轮归属，以及真实 hook 在 StrictMode 下的滚轮接力、键盘打断、滚动条显隐／拖拽、滚动恢复、窗口变化、reduced-motion 与隐藏／卸载清理。
- `tests/collectionPivot.test.mjs`：分类／详情／返回方向、可见区域分组与数量上限、有界条目测量、输入从当前帧收稳与恢复滚动事件的区分，以及真实导航／面板动效 hook 的 StrictMode、快速连切和 reduced-motion 清理。
- `tests/browseTransition.test.mjs`：收藏、播客和 quickplay 共用控制器、静止导航与背景、标题及封面的独立显现、播客根滚动恢复和稳定媒体身份、有界样式读取、面板接管及隐藏／reduced-motion 清理。
- `tests/contentEntrance.test.mjs`：长列表与网格的滚动恢复、首屏选择、常数布局读取、错峰封顶、总量上限和条目当前帧反向。
- `tests/surfaceTransition.test.mjs`：成对交接、当前帧反向、有限退场层、延迟挂载、主音频唯一性与长歌曲列表的有界复制。
- `tests/navigationMotion.test.mjs` / `tests/wheelScroll.test.mjs`：顶层导航立即挂载、同批次反向与快捷键焦点，以及粗步进识别、滚轮目标接力／反向／边界、原生输入接管和真实 hook 的 reduced-motion／卸载清理。
- `tests/uiBehavior.test.mjs` / `tests/canvasLifecycle.test.mjs`：真实 React 组件在 StrictMode 下的焦点、入场清理与 Canvas 停转/唤醒行为。
- 视觉验收检查真实播放、快速连切可打断、FLIP 连续性、reduced-motion、键盘交互与窄窗口。按根目录的启动授权规则实测；歌词专项场景见 [歌词规范](engineering/lyrics.md)，本地 `docs/lyrics-motion-review.md` 若存在可补充参考。

## 收藏对象浏览

顶层页面走 `requestNavigation`。收藏分类沿用 `COLLECTION_CATEGORY_ORDER` 与历史方向，播客沿用根分区／详情顺序；两边都由 `browseTransition.ts` 执行横向交接和内容显现。收藏分类、搜索、数量及播放列表左栏保持稳定；播客分区、搜索和子标签保持稳定。语义区域负责位移，封面错峰淡入，歌曲与播客文本列表整体显现；参数统一来自 `BROWSE_MOTION`。

连续浏览的艺术家、专辑、流派各栏由 `.collection-browse-pane` 划分语义区域。分类交接和详情返回沿用共享控制器；名称索引作为文本列表显现，封面仍使用有界入场。索引内选择与歌曲列排序只更新当前历史条目，不递增 revision，不重播入场或移动保留的左栏。选择其他艺术家／流派将专辑栏定位到顶部；详情返回先恢复各栏滚动与焦点，不被初始化重置。

长歌曲列表按可见行窗口渲染，滚动位置变化只有跨行窗口时才更新 React。原生滚动与 `wheelScroll.ts` 的弹簧写入在绘制前同步窗口，使用真实小数行高，避免快速反向滚动、缩放或恢复位置时露出占位空白。名称与封面保留完整布局锚点，窗口限制不改变完整播放来源、排序、焦点或历史。

`surfaceSnapshot.ts` 对收藏规则网格／列表按可见范围复制；quickplay、播客及正在播放的可变尺寸条目保留屏幕外布局占位，不复制内部封面和控制子树。快照恢复实际滚动容器的位置；横向全景离屏分组不读取每个磁贴的几何，入场条目共享区域裁切测量。原 React 子树按正常生命周期卸载。

快速切换不排队等待；先捕获当前画面再交接，不先加速旧动画。退场窗口内反向返回时接续旧画面的可见位置与透明度；已显现的封面不重新错峰。每次最多一层内容退场，旧 React 子树照常卸载。历史返回先恢复滚动锚点、选择和焦点；恢复产生的同位置滚动事件不会打断动画。移动区域内的滚动、指针和键盘输入从当前 transform/opacity 用短过渡收稳，不吞掉输入或反复启动；静止导航上的输入不影响动画。窗口调整、隐藏、卸载及 reduced-motion 开启清理动画与退场层。首次挂载由顶层入场负责，普通数据更新不重播。

艺术家详情的标签顺序由 `COLLECTION_ARTIST_TAB_ORDER` 决定，`useCollectionPanelMotion` 只动画标签下方内容；选择另一播放列表时只动画右侧内容。键盘与鼠标采用同一分组运动，焦点不等待动画。搜索输入直接更新，面板首次挂载不叠加外层入场。播客冷加载先直接展示加载状态，只有加载占位、还没有节目／单集或详情内容时保留入场机会；等待期间用 `data-browse-waiting` 暂隐数据区标题并保留布局，避免标题先在终点显示、数据返回后跳到起点。实际内容挂载后同时释放暂隐与执行入场；后续数据更新不重播，离开页面或开启 reduced-motion 时取消观察器并清理暂隐标记。资料库的本地单集搜索筛选区不移动，结果区域独立过渡；请求尚未启动时也标记首次数据待加载，不把入场消耗在空状态上。节目详情按节目身份与单集区域分组。资料库节目以 feed ID 记录当前显现帧，标题和未听数量变化不会破坏快速返回的接续。

跨页面验收覆盖收藏 → 播客资料库 → 收藏、收藏播放列表 → 播客 → 原播放列表及返回 quickplay；至少检查等待真实数据的首帧、80/180ms 中间帧、快速反向、键盘选择、默认／最小窗口和减少动态效果。quickplay 的数据快照保留父页样式上下文，使封面尺寸和横向滚动位置与原画面一致。

滚动区域通过 `--motion-browse-gutter` 预留与位移相等的水平余量，负边距与补偿 padding 保持内容最终位置和宽度不变。外层浏览页面允许这段小位移显露，滚动区域继续裁切垂直内容，防止轻移时首列文字或末端操作被截掉。收藏／播客所在的 `.workspace` 使用不可滚动的 `overflow: clip` 裁切，防止键盘聚焦或滚动到控件时带动整个工作区及左栏。此余量是静态布局，动画仍只改变 transform 和 opacity。

## 参照与适配

- [Zune 桌面前端负责人的项目记录](https://www.heysroons.com/projects/zune-music-player)说明其排版、媒体内容和运动属于同一体验；[同期实测](https://www.gsmarena.com/zune_software-review-539p2.php)记录 quickplay 通过大小、透明度和前后层次交接。Zone 保留自己的桌面布局及全景视差。
- [WP 导航原始文档](https://learn.microsoft.com/en-us/archive/msdn-magazine/2011/april/msdn-magazine-mobile-matters-windows-phone-navigation-part-2-advanced-recipes)区分空间切换、共享元素连续性和浮层运动，强调成对交接；不把 Turnstile 强行套在每次列表浏览上。
- [Windows 8.1: Live Tiles](https://www.youtube.com/watch?v=raMN90tJD0s)可观察图片与文字面板的滑动更新；[Windows Phone Holly Pinning Live Tiles 2013](https://www.youtube.com/watch?v=CaCFNRJRoNQ&t=7s)展示固定联系人及联系人磁贴的信息更新，未完整演示手动拖动重排。`TILE_MOTION` 的 peek 2000ms、浮起 240ms、重排 400ms、落位 500ms 与缩放量参照 [WinJS 动画源码](https://github.com/winjs/winjs/blob/master/src/js/WinJS/Animations.js) 的 Peek、dragSource、Reflow；侧面连续性、退暗与桌面拖动交接经过 Zone 适配，并非从 WP 视频逐帧测得的原版参数。
- [WinJS 动画源码](https://github.com/winjs/winjs/blob/master/src/js/WinJS/Animations.js)的 `enterPage` 将 1000ms 位移与 170ms 淡入分开，使用 `(0.1,0.9,0.2,1)` 缓动及有上限的错峰；`enterContent` 则独立采用 28px 纵向位移、550ms 收稳和 170ms 淡入。Zone 借鉴页面交接与内容进入分别编排的方式，单独调校首屏条目的行程、时长与错峰；这些值不是 Zune 原版的测量参数。
- [Rune 的动效实验](https://github.com/Losses/rune)可作为现代复刻的编排参考，其 Turnstile 实验采用 600ms 及分组区间；它不能证明原版参数。
