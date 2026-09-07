# 歌词：数据、搜索、同步与导出

本文由根目录 [AGENTS.md](../../AGENTS.md) 按任务索引引用。文中的行为与安全边界适用于相关改动；标为当前实现的参数用于定位，可在验证后调整。代码路径均相对于仓库根目录。

歌词功能已经进入可用阶段。后续修改应建立在现有链路上，不要另起一套搜索、缓存、解析或播放时钟。

### 统一数据模型与来源顺序

- 所有来源最终归一化为 `LyricsDocument`：`format` 为 `plain`、`line` 或 `word`；行可包含翻译、音译、逐词时间和带独立时间轴的背景人声。
- 音译是原文的罗马字/读音辅助（TTML `x-roman`），不是翻译；背景人声是 TTML `x-bg` 提供的独立演唱轨，不从普通文本猜测生成。
- 已手动选定的在线候选或本地文件是按曲目保存的显式覆盖，二者互斥；清除覆盖后恢复自动发现。
- 没有显式覆盖时，自动顺序为：音频标签内嵌歌词 → 同名 sidecar（`.ttml` → `.lrc` → `.txt`）→ 在线自动搜索。现有实现让内嵌歌词优先于 sidecar，不要在无产品决策时悄悄交换。
- `src/utils/demoLyrics.ts` 只在开发环境中作为动效预览兜底；生产环境无歌词时显示 missing/error，演示歌词禁止导出或写入正式缓存。
- 解析结果缓存会校验 parser version、`sourceId`、源文件修改时间和曲目时长。改变解析语义时应递增 `LYRICS_PARSER_VERSION`，避免继续读取旧文档。

### 在线 Provider 与搜索语义

当前实现有四个默认启用的来源；优先级与超时以 `src/lyrics/providers.ts` 为准，下面是定位用的当前值，用户可在设置中调整顺序或停用：

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
- 歌词舞台隐藏时整体使用 `inert`，包括无歌词时的搜索／文件按钮，避免透明的控件截获 Tab 焦点；显示后恢复正常交互。
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
- 歌词舞台结构或动效变化：运行 `npm run build` 和 `npm test`，并检查真实播放、手动浏览、点击跳转、减少动态效果和窄窗口布局。

## 网络与解密边界

- 在线歌词请求一律经 Rust 命令 `request_lyrics_provider` 中转，前端不直接 fetch：
  - URL 白名单校验（`validate_lyrics_provider_url`）：只允许已注册的 LRCLIB、AMLL TTML DB、网易云音乐和 QQ 音乐 HTTPS 主机与固定 API 路径，无端口、禁重定向；QQ 回退搜索的查询参数也逐项校验。新增 provider 必须同时注册允许规则。
  - 超时钳制在 1.5s–20s；响应体大小有上限（`LYRICS_PROVIDER_RESPONSE_LIMIT`）；仅对 502/503/504 重试一次。

`src-tauri/src/qrc.rs` 的解密/解压必须保持输入与输出大小限制。

## 代码与补充资料

入口为 `src/hooks/useLyrics.ts`、`src/components/LyricsStage.tsx`、`src/components/lyricsStage/`、`src/lyrics/providers.ts`、`src/utils/lyrics*.ts` 和 `src-tauri/src/lyrics*.rs`。

本地 `docs/lyrics-experience-plan.md`、`docs/lyrics-motion-review.md` 和 `docs/design-qa.md` 若存在，可作历史设计与视觉证据；它们不纳入版本控制，必要规则与验证范围以本文和 [动效规范](../motion-system.md) 为准。
