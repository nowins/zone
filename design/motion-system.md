# Zone 动效系统：Alive in Motion

本文档是 Zone 动效系统的说明书：设计原则、token 体系、`src/motion/` 内核 API，以及新组件接入动效的标准做法。改动动效前请先读这里；改变约定或 API 时同步本文，全局规则或入口变化才更新根目录 `AGENTS.md`。表中数值是当前实现，以 `src/motion/tokens.ts` 为事实源，可按任务需求验证后调整。

## 设计原则

动效的存在是为了让界面可理解、有生命感、帮助用户建立空间心智模型——不是为了好看。六条工作原则：

1. **短**：绝大多数过渡 ≤260ms，拒绝拖沓。常规交互退场比入场更快更轻。
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
| `--motion-chrome` | 700ms | 正在播放页 chrome 隐没（刻意慢） |
| `--motion-cycle` | 800ms | 慢速环境循环（cycle 磁贴交叉淡化） |
| `--motion-loader` | 4500ms | 长循环加载器（Metro 轨道），不是过渡时长 |
| `--motion-ease-standard` | (0.23,1,0.32,1) | 强 ease-out，默认交互曲线 |
| `--motion-ease-entrance` | (0.18,0.88,0.24,1) | 入场专用 |
| `--motion-ease-exit` | (0.55,0.06,0.68,0.19) | 加速离场，**退场专用** |
| `--motion-ease-emphasis` | (0.175,0.885,0.32,1.275) | 轻微过冲（tilt 按压） |
| `--motion-ease-dissolve` | (0.4,0,0.6,1) | 正在播放闲置隐藏的渐缓溶解 |
| `--motion-drift-s/m/l` | 8/22/48px | 位移幅度三档 |
| `--motion-stagger-step/max` | 24/144ms | 列表错峰步进与上限 |

TS 侧对应常量：`MOTION_DURATIONS`、`MOTION_EASINGS`、`MOTION_DRIFT`、`MOTION_STAGGER`、`SPRING_PRESETS`（`snappy` 近临界阻尼 / `gentle` 页面级 / `bouncy` 约 20% 过冲）。其中 `snappy` 是现役生产预设（FLIP、quickplay 滚轮）；`MOTION_TWEENS.standard` 用于磁贴重排／尺寸调整的 FLIP 补间；`gentle` / `bouncy` 仍是**备料预设**。

通用短时长原则用于交互反馈，不给分层编排、悬停等待、循环加载或音频 DSP 包络套统一上限。正在播放入场和 Canvas 收敛使用 `tokens.ts` 中的 `NOW_PLAYING_MOTION`，不要在组件中复制时长。

正在播放闲置隐藏是自动退隐的刻意例外：返回、队列、底部控制区共用 chrome 档 700ms 与 dissolve 曲线，在原位同步降低透明度；唤回用 content 档 220ms 与 standard 曲线，CSS transition 从中间值反向接续，不重新挂载或重播入场。歌曲信息不随闲置状态变暗。用户主动隐藏队列仍走 micro 档 Presence；reduced-motion 下两类过渡均收缩至 instant 档。暂停、焦点和操作中的计时保护见 [播放视觉规范](engineering/playback-visuals.md)。

`tokens.ts` 中的 `TILE_MOTION` 统一维护磁贴长按、首次更新、后续更新间隔、背面停留、peek／flip／单格翻面及入场错峰参数。当前首轮更新在可见后 6–14 秒，后续间隔 24–48 秒，背面停留 5 秒，各磁贴独立错峰。小磁贴与关闭动态的磁贴不循环；`useTileActivity` 统一监听可视区、页面可见性与悬停／聚焦，编辑切换 DOM 宿主时重新绑定。reduced-motion 下停止自动翻面和封面替换，重排直接落到终态。

`PANORAMA_MOTION` 维护首页视差、拖动惯性和滚动条停留：背景大字和底色当前分别跟随横向滚动的 22% / 8%，最大行程 480 / 240px；底色平面按 token 扩展，平移时不露出边缘。`useQuickplayPanorama` 直接写 DOM transform 与滚动条位置，不用逐帧 React state；返回页面时在同一 layout effect 内恢复位置，不闪现滚动条。普通滚轮与拖动释放共用可打断的 `snappy` 弹簧；触控板横向输入、滑块拖动和键盘定位不叠加惯性。短滚动条在最后一次位移后停留 700ms，再按 micro 档淡出；拖住滑块时不隐藏，键盘焦点由 `:focus-visible` 保持可见。页面隐藏或卸载时取消动画与显隐计时器，reduced-motion 下停止视差、即时定位并收缩淡出；没有持续空闲动画。

其他已登记的当前编排：歌词加载呼吸 1.1s、歌词行移动的 `cubic-bezier(0.77,0,0.175,1)`、`TILE_MOTION` 中的 Lumia/Metro 校准组（`FlipTile` peek 600ms 与其 MetroSlideIn 曲线 `(0.22,0,0.05,1)`、flip 两半各 200ms、`MosaicFrames` 单格半翻 280ms、cycle 离场清理 900ms、quickplay 磁贴入场错峰 46ms 步进/460ms 封顶与 900ms 挂载窗口）。收藏页 `.album-play` 在封面项悬停或键盘聚焦时用 press 档淡入，无额外等待。调整时检验对应交互与 reduced-motion，不将这些参数当成必须另行审批的永久限制。

## 内核 API（`src/motion/`）

- `math.ts` — `clamp` / `clampInt` / `lerp` / `smoothstep` / `easeOutCubic` / `easeInCubic`。所有 util 的统一来源，不要再本地重复实现（`visualizer` / `beatAnalysis` / `audioGlow` / `tiltPress` / `nowPlayingCanvas` / `lyricsMotion` 均已收编）。
- `spring.ts` — 半隐式欧拉弹簧：`createSpring(from)`、`advanceSpring(state, preset, target, dtMs)`、`springSettled(state, target)`。retarget 时把上次返回的 state（含 velocity）继续传入即得惯性接力。
- `tween.ts` — `cubicBezier(x1,y1,x2,y2)` 求值器；`MOTION_TWEENS` 是与 easing token 同源的预建函数。
- `animate.ts` — `animateValue({ from, to, spring? | tween?, onUpdate, onComplete })` → `{ cancel, retarget }`。全应用共享一个 rAF 循环，空闲自动停转；测试可注入假时钟（`_setAnimationClockForTesting`）。
- `flip.ts` — FLIP registry：`registerFlipSource / registerFlipElement(id, ...)`、`takeFlipSource(id)`（取出即删，>1s 过期）、`computeFlipDelta(source, target)`。
- `coverFlip.ts` — 封面共享元素飞行编排：`playCoverFlip({ source, target, imageSrc, holdUntil?, revealTargetWhen?, onDocked? })`。弹簧等 `clone.decode()` 就绪才起飞（400ms 超时兜底），飞行全程每帧重测目标矩形，落地带速度比例动态模糊。仅在「播放条/quickplay 大封面 ↔ 正在播放曲目卡」链路使用；新共享元素场景参考它另建编排，不要直接散写克隆逻辑。
- `presence.tsx` — `<Presence show exitDurationMs exitClassName?>`：show 转 false 时保留子树、挂退场类、超时卸载；`useLastNonNull(value)` 冻结关闭前快照供退场窗口渲染（退场窗口内 props 冻结不刷新，窗口应保持在 micro 档，不要拉长）。当前歌词设置面板和在线来源搜索面板也采用这条链路。
- `pageTransition.ts` — `resolvePageTransition(from, to)`：同级 pivot（方向 ±1）、进 nowPlaying = push、返回 = pop。App 的 `requestNavigation` 消费它：direction/exitMs 驱动计时，exitDriftPx/enterDriftPx 由 shell 写成 `--motion-exit-drift`/`--motion-drift`（push/pop 比同级 pivot 走得更远）；`coverFlip` 标记由 FLIP registry 侧链路消费。
- `useReducedMotion.ts` — `useReducedMotion()` hook，JS/rAF 侧统一入口。

## 接入指南

### 给新列表/内容块加入场

把元素类名加进 `motion.css` 的 feather 选择器组即可（`animation: motion-feather-in var(--motion-content) ... backwards; animation-delay: var(--stagger, 0ms)`），并在 stagger 表里补 `:nth-child` 行。重要内容需要更大幅度时，在该元素的规则里设 `--motion-drift: var(--motion-drift-l)`。

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

### 页面导航

不要直接 `setPage`——走 `requestNavigation`（`src/App.tsx`），它负责退场窗口、方向（`--motion-dir`）与可打断逻辑。

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
- 每帧数据（可视化帧）走 `visualizerBus.ts` 单槽总线，不走 React state/props。

## reduced-motion 约定

全项目只有一个 `@media (prefers-reduced-motion: reduce)` 块：`src/styles/motion.css` 末尾。策略：入场/反馈动画 `animation: none` 落到终态；过渡压到 `--motion-instant`；空间变换（tilt、歌词缩放/模糊、长音拉伸）清零；**退出不留下静止窗口**——退场使用短的纯透明度淡出，JS 生命周期（导航计时器、Presence 卸载）经 `resolveExitDurationMs` 收缩到同一 instant 档。新增带动效的组件时把选择器补进清单；JS/rAF 侧用 `useReducedMotion()` 关闭漂移/FLIP/滚轮惯性等连续运动。两个正在播放 Canvas 收敛后停止连续 rAF；播放中的光焰用固定低亮静帧，暂停后消退清空，不播放伪音频动画。

## 测试与验证

- `tests/motion.test.mjs`：内核行为（弹簧收敛/过冲/惯性/高频 retarget 时序、补间求值、动画器、FLIP 数学、页面过渡表、token 完整性）。新增被测模块时同步 `tsconfig.test.json` 的 include，跨模块导入带 `.js` 后缀。
- `tests/coverFlip.test.mjs` / `tests/coverFlipBehavior.test.mjs`、`tests/visualizerBus.test.mjs`：FLIP 接线与运行时行为、可视化总线守卫。
- `tests/reducedMotion.test.mjs`：reduced-motion 下退出淡出与 JS 生命周期的同步守卫。
- `tests/lyricsSettingsUi.test.mjs` / `tests/lyricsDisplay.test.mjs`：歌词设置面板的 Presence 接线、显示偏好持久化和字号归一化。
- CSS/结构守卫（`nowPlayingCss.test.mjs` 等）会因类名/编排变化失败，按新结构同步，不放宽语义。
- `tests/tileInteraction.test.mjs`：真实磁贴组件的 StrictMode 生命周期、内容停留、隐藏／编辑／reduced-motion 停转与恢复，以及长按、键盘和外观设置行为。
- `tests/panoramaBehavior.test.mjs`：首页分组与视差边界、滚轮归属，以及真实 hook 在 StrictMode 下的滚轮接力、键盘打断、滚动条显隐／拖拽、滚动恢复、窗口变化、reduced-motion 与隐藏／卸载清理。
- `tests/uiBehavior.test.mjs` / `tests/canvasLifecycle.test.mjs`：真实 React 组件在 StrictMode 下的焦点、入场清理与 Canvas 停转/唤醒行为。
- 视觉验收检查真实播放、快速连切可打断、FLIP 连续性、reduced-motion、键盘交互与窄窗口。按根目录的启动授权规则实测；歌词专项场景见 [歌词规范](engineering/lyrics.md)，本地 `docs/lyrics-motion-review.md` 若存在可补充参考。
