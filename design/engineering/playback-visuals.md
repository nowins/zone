# 播放、音频分析与正在播放视觉

本文由根目录 [AGENTS.md](../../AGENTS.md) 按任务索引引用。文中的行为与安全边界适用于相关改动；标为当前实现的参数用于定位，可在验证后调整。代码路径均相对于仓库根目录。

## 播放控制边界

- 本地音乐支持 `mp3`、`flac`、`m4a`、`aac`、`wav`、`ogg`，事实源是 `src-tauri/src/library.rs` 的 `is_supported_audio`；增加格式时同步扫描、协议 MIME 与解码验证。
- M4A 中的 ALAC 经 `audio_transcode.rs` 在后台转换为无损 PCM32 WAV，再由同一 `zone-audio` 协议提供 Range 与 CORS。缓存按原文件路径、长度和修改时间区分，不改写媒体源文件；当前支持最高 192 kHz 的单/双声道，源文件上限 512 MiB、输出上限 1 GiB、转换时限 60 秒，缓存总量上限 2 GiB。超过边界或损坏文件明确失败，不跳过损坏数据生成成功缓存。
- `src/hooks/usePlaybackControls.ts` 拥有播放尝试与 transport ref；`audioPlayAttemptRef` 仅由 `beginPlayAttempt` 递增，`runPlayAttempt` 统一处理 `audio.play()` 成功/失败，避免旧请求回调覆盖新音源状态。
- 音乐启动恢复保持暂停，显式播放、切歌与自然续播才建立播放意图；SmartDJ 启动恢复只恢复队列和推荐会话，不抢占播客。音乐位置写入 `zone.sqlite` 已有的 `music_playback_state.position_ms`，播放中每 5 秒及状态变化后保存；元数据就绪后恢复位置，超出实际时长或已接近结尾时从头开始。
- `usePodcastPlayback.ts` 通过 `podcastTransport.ts` 暴露产品状态与语义方法。播客自然结束委托 `handleEpisodeEnded`，待播消费以对应音源实际开始为准；守卫统一复用 `src/utils/playbackTransport.ts`。
- Web Audio 图由 `useAudioEngine.ts` 持有，通过 `AudioEngineHandle` 接入播放控制。跨 hook 共享 ref/state 只创建一次，沿 App 的单向传参和 late-bound ref 接线；修改组合关系先读 [架构地图](architecture.md)。

## 音频分析与 Canvas 生命周期

- 音乐节拍预分析通过 `music_decode_beat_window`：只接受数据库曲目 ID，原生端最多解码前 30 秒、22050 Hz 单声道，传输有版本/文件修改时间/长度头的二进制 PCM；`music_cancel_beat_window` 取消旧请求。节拍计算在 `src/workers/beatAnalysis.worker.ts` 执行，前端只缓存最多 32 个按文件版本区分的节拍结果。失败回退到实时分析，不影响播放；播客不得进入此链路。
- 可视化采样由普通窗口中的音乐播放共享，quickplay、收藏及其他普通页面与正在播放页沿用同一总线；浏览页面切换不重启采样或触发节拍预分析。仅在音乐正在播放、音量非零、窗口文档可见且未开启减少动态效果时采样；小屏与播客播放停用。光焰在暂停、静音或减少动态效果后收敛并停止连续 rAF；拼贴在暂停或减少动态效果后收敛停转，静音时仍保留封面运动。Canvas 由封面加载、尺寸、播放状态或可见性变化唤醒。
- 当前 DSP 参数（以 `src/hooks/useAudioEngine.ts`、`src/utils/visualizer.ts` 为准）：4096 点 FFT（平滑 0.35、上限 -12 dB）与真实 PCM 静音门限；12 个频段独立包络和瞬态在 `AudioVisualizerAnalyzer` 生成连续轮廓。频段字节值已处于对数分贝范围，归一化均值用 1.5 次幂映射，避免旧三次幂叠加轮廓衰减后让人声、原声乐器只剩底边细线；中等强度且低频稀少的持续声音也应可见，同时为强低频与瞬态保留差异。实例随采样会话创建，seek 时清理旧段落的瞬态；总线传递 samples/transients/bass/texture，Canvas 不再叠加固定中央山形或时钟正弦扰动。无信号发布零帧，预测拍点只有实时瞬态确认后才能驱动光焰。
- 色彩连续性约束：初始化和换封面时不得产生空间断层。当前用连续 RGB 插值，旧嵌套 HSL 最短弧插值在色相接近 180° 时会跳变；若更换算法，需要覆盖该回归场景。

可视化必须使用真实音频分析，播放音乐时不允许用空闲动画冒充。

WebView2 隐藏原生窗口时可能仍报告 `document.visibilityState = visible`。`useNativeWindowVisibility` 在焦点/文档可见性变化时及每秒读取一次主窗口可见/最小化状态，不允许重叠请求；状态变化通过 DOM 信号停用音频采样与 Canvas，显示窗口后重新唤醒。它只查询当前主窗口，不增加通用窗口权限。

关键约束：

- Tauri `convertFileSrc(path)` 默认走 `asset` 协议（通常是 `http://asset.localhost/...`）。
- `asset` 初始无文件访问范围，原生命令通过 `image_scope.rs` 仅授权返回的封面与艺术家图片；校验扩展名、图片文件头和 8 MiB 上限，不授权目录或数据库文件。CSP 的媒体与连接入口只允许本地应用和受控协议，图片加载仍需原生文件范围校验。
- dev 下页面源通常是 `http://localhost:5173`（vite 端口 5173，strictPort，host 127.0.0.1）。
- Web Audio 可以播放跨源媒体，但媒体响应缺少有效 CORS 头时 `createMediaElementSource` 输出全零。
- 应用使用自定义 Tauri 协议 `zone-audio` 播放音频：
  - `convertFileSrc(activeTrack.path, "zone-audio")`
  - 响应带 `Access-Control-Allow-Origin: *`、字节范围支持、正确的音频 content type
- 主 `<audio>` 保持 `crossOrigin="anonymous"`（`App.tsx` 中既有属性赋值也有 JSX 属性）。
- `zone-audio` 路径需要百分号解码与路径/音频格式校验，Range 响应保持分块上限，不能放宽为任意文件读取或无界响应。当前实现按本地路径读取受支持音频，并非数据库 ID 白名单；不要将其误描述为只允许已入库曲目。
- 除非有充分理由，不要再引入第二个隐藏的分析用 `<audio>`。目标音频图：

```text
audioRef -> MediaElementAudioSourceNode -> AnalyserNode -> GainNode -> destination
```

播客开启语音均衡或静音加速时，`podcastAudioEnhancement.ts` 在 Analyser 与 Gain 之间按需插入 `podcastAudio.worklet.js` 的 AudioWorklet；模块以独立本地文件加载，保持既有 CSP。音乐及关闭增强时逐样本旁路。均衡基于真实 PCM RMS、用户音量补偿和有界平滑增益，静音不提升底噪；持续静音 350 ms 后临时加速至所选倍速的两倍（最高 3 倍），声音恢复时回到所选倍速。暂停、定位、音源或偏好变化均清空检测状态并使旧消息失效。处理不依赖可视化 rAF 或 React 逐帧状态，在减少动态效果和后台收听时仍工作；Worklet 失败则重新连接原声链路并提示，不中断播放。

- 未下载播客经 `zone-podcast`、已下载播客经 `zone-audio`，二者都复用主 `<audio>`；播客不得进入音乐 queue、收藏或播放统计，也不得触发音乐的整文件节拍预分析。

如果可视化看起来是假的或从不响应，先在 dev 控制台检查：

```text
MediaElementAudioSource outputs zeroes due to CORS access restrictions
```

## 正在播放的视觉方向

普通页面的底部也复用 `AudioGlowCanvas`：由 App 挂在 `.shell` 下，位于页面内容与透明播放条之后，切换 quickplay／收藏时不跟随页面滑动或重新挂载。播放条不设独立底色、边线或阴影；quickplay 底色与收藏封面背景在下沿淡出，保留控件的布局空间和焦点区域。普通页面光焰亮度由 `base.css` 的 `.shell > .audio-glow-canvas` 控制，共用画布尺寸仍在 `now-playing.css`；正在播放页继续在自身拼贴之上绘制光焰。播客播放不展示音乐光焰。

正在播放页应贴近 Zune 4.8：

- 背景：
  - 视觉层为 Canvas 实现（`NowPlayingMosaicCanvas` + `AudioGlowCanvas`，测试 `tests/nowPlayingCss.test.mjs` 断言其为 canvas 而非旧 SVG 分层）。
  - 用本地专辑/艺术家封面做拼贴，优先当前艺术家的专辑；已补充的艺术家照片（`artist_image_path`/`artist_images`，去重后上限 4 张）以四份权重（当前艺术家专辑的两倍）混入拼贴，大封面与共享封面仍只用专辑封面。
  - 从当前封面派生柔和色彩罩染；另有动态色彩场（`createMosaicColorFieldSampler`，`globalCompositeOperation = "color"`）沿多角度慢变轨迹漂移，色相随位置变化。
  - 只做缓慢的平移/缩放，动效像呼吸而不是幻灯片；磁贴随机翻面稀少且缓慢。
  - 换曲保留磁贴几何与已解码图像；新图解码完成后逐片交叉淡化，连续切歌接续当前过渡。同专辑不重建墙；缺失或失败封面保留旧图，首次加载使用其他已就绪封面补位。缓存淘汰不得清空仍被磁贴引用的画布。
  - 翻面固定正反两张已解码画布，在侧面切换，结束后保留反面；不与换曲淡入叠加。仍在淡入的磁贴和未就绪反面不参与翻转。翻转期间的新封面池等本次落稳后接入，重复尺寸通知不重建分配，真实缩放保留已有封面分配；暂停让当前翻转完成，减少动态效果直接收稳。
- 入场：
  - 页面以 `now-stage-dissolve`（纯透明度溶解）进入，无位移/缩放。
  - 队列面板先淡入，拼贴墙磁贴非顺序错峰显现，普通曲目卡随后淡入。共享封面飞行使用已解码的真实封面快照，文字在飞行期间出现，落位仅做短暂轮廓交接；返回时封面与页面同时退场，不等底部栏重挂载后起飞。时长与延迟由 `src/motion/tokens.ts` 的 `NOW_PLAYING_MOTION` 及 `src/styles/animations-responsive.css` 编排，不在本文固定毫秒值。
- 排版：
  - 允许大号、部分裁切的幽灵文字。
  - 功能性文字保持可读且克制。
  - 应用内避免解释性 UI 文案。
- 控制：
  - 极简线性控制；播放中无操作约 5 秒后 chrome 进入 `chrome-immersive`，返回、队列和底部控件在原位同步淡出，只留下拼贴与歌曲信息，无中间虚化态。鼠标或键盘唤回接续当前透明度，不重播页面入场，也不改变队列滚动位置；过渡参数见动效系统。
  - 暂停、页面入场、保存对话框、指针按住控件或键盘焦点仍在页面内时不进入闲置隐藏。文档隐藏／窗口失焦时取消计时，恢复后重新计时；隐藏的控制区使用 `inert`，不可被误点或聚焦，文档级键盘输入可唤回。
  - 控制区不应主导页面。
  - 歌曲信息中的艺术家与专辑可进入收藏详情；返回恢复正在播放页及入口焦点。浏览详情不改变当前曲目、队列或播放进度，统一由 `useNavigation.openCollectionEntity` 接入收藏历史。
  - 正在播放列表保持播放队列原顺序，当前曲目只高亮；超出可见范围时仅滚动列表使其露出。底部进度条相对整页居中，播放控件独立靠右，音量位于右侧控件下方；调整内部间距时保持这组 Zune 布局关系。此页隐藏全局设置入口，保留窗口控制。
  - App 通过收藏索引缓存队列曲目数组；正在播放页缓存队列行，播放进度更新不重新创建整条队列。缓存行通过 `useEvent` 调用最新播放动作，队列顺序、曲目资料或当前曲目变化仍即时更新。
  - 队列按钮切换整个列表的显示/隐藏，短队列同样可隐藏；退出经 `Presence`，隐藏期间不可聚焦，重新显示时定位当前曲目。歌词与队列互斥显示，关闭歌词恢复此前的队列显隐偏好。
  - 队列面板贴底部控制区上方，短队列按真实内容高度收合，保存按钮紧随列表；长队列达到可用高度上限后只在列表内部滚动。不得同时固定面板上下边界或让一首歌的列表撑满剩余空间。
  - 右侧控制组以播放键居中，两侧等宽；音量滑杆在下方居中常显，滚轮向上增大、向下减小，并限制在 0–100。循环关闭为灰色双箭头、列表循环为强调色双箭头、单曲循环为带数字 1 的强调色图标。
  - 音乐正在播放支持原生窗口全屏：按钮切换，Esc 优先退出全屏，离开页面恢复普通窗口。`useNowPlayingFullscreen` 串行处理切换与退出，失败保持可重试；仅新增 `core:window:allow-set-fullscreen` 权限，全屏期间隐藏标题栏。
- 可视化：
  - 应像底部低暗的红/橙色光晕或火焰（`audioGlow.ts` 生成真实音频轮廓），不是传统均衡器。
  - 当前渲染将各频段的局部能量映射为向上连续衰减的低分辨率光场，再平滑放大；不描边或填充封闭山形。频段使用独立局部包络，避免相加饱和后整片变成固定拱形。
  - 外层 `.visualizer` 背景保持透明或极淡。
  - 避免规则滚动的正弦波，运动由低频/低中频能量与波形包络驱动。
- 歌词模式：
  - 与「正在播放」同一空间的第二状态，不是新页面；背景拼贴与歌曲信息保持连续。
  - 当前行是空间中心，相邻行随距离降低透明度、缩小并轻微模糊；逐词进度由 `requestAnimationFrame` 直接读音频时钟驱动。
  - 同步、手动浏览与导出约定见 [歌词规范](lyrics.md)。

## 参数与动效的适用范围

保持真实音频响应、色彩连续、控制区可读以及暂停/隐藏后停转是行为约束。FFT、频段数、attack/release、画布高度与入场延迟是当前实现参数；在任务范围内可根据实测调整，并同步代码、相关测试和本文，不能用假波形替代真实信号。DSP 包络不是 UI 转场时长。

通用导航、Presence、FLIP、token 与 reduced-motion 接线遵循 [动效系统](../motion-system.md)；视觉排版遵循 [组件规范](../component-guidelines.md)。

## 验证

- `npm run build`、`npm test`；音频轮廓、静音、seek 与生命周期行为重点看 `tests/visualizer.test.mjs`、`tests/audioGlow.test.mjs`、`tests/beatAnalysis.test.mjs`、`tests/visualizerBus.test.mjs`、`tests/audioEngineLifecycle.test.mjs`、`tests/canvasLifecycle.test.mjs`、`tests/nowPlayingCanvas.test.mjs`；`tests/mosaicFlipRendering.test.mjs` 检查实际拼贴组件画出的正反面、落稳、换曲、加载与缩放交接。
- 协议或原生解码变化运行 `cargo check` 与相应 Rust 测试；协议/发布路径变化还需 `npx tauri build --no-bundle`。
- 播放协议和可视化行为必须在真实 Tauri 音乐播放中验证：进入/退出、换曲、seek、静音、暂停/恢复、文档隐藏及 reduced-motion。纯浏览器 Vite 不能证明自定义协议或 CORS 链路正常。
- 光焰改动比较不同音乐及同一首歌的安静/节奏段落，检查峰位、宽度和局部亮度确实随信号变化；检查 quickplay／收藏／正在播放往返时的背景衔接、播放连续性和底部控件焦点。色场改动检查首次入场与换封面过渡。至少检查默认窗口和最小窗口，涉及高分辨率 Canvas 性能时补相应尺寸验证。
- 队列改动检查单首／少量／长队列高度、点击中间曲目、上一首/下一首、显隐及重新显示时的定位；控件改动检查循环三态、音量滚轮/键盘/边界、原生全屏进入与 Esc 退出。闲置隐藏需检查淡出中唤回、滚动位置保持、键盘焦点、暂停／拖动／对话框阻止隐藏和 reduced-motion。`tests/nowPlayingChrome.test.mjs` 覆盖真实页面的闲置生命周期与队列交互，`tests/transportControls.test.mjs` 覆盖控制组件和全屏 hook 的竞争/失败恢复。封面改动检查慢加载、加载失败、同专辑和连续切歌，过渡不得中途变亮或露出空白。
- 启动应用遵循根目录授权规则；若必要交互验证无法完成，说明尚未验证的部分，不用静态检查冒充实测通过。
- 共享封面需检查底部栏与 quickplay 大封面入场、返回、飞行中反向、底部栏重挂载、窗口尺寸变化和 reduced-motion 切换，文字不等待飞行停稳，返程不二次起飞，最后不得残留克隆或隐藏的真实封面。`tests/coverFlipBehavior.test.mjs` 用可控 WAAPI 完成时钟验证交接、取消和返程生命周期；实际插值、布局及 CSS 编排另做浏览器交互验证。
