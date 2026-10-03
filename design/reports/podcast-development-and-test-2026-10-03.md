# 播客功能与界面开发、测试报告

日期：2026-10-03（Asia/Shanghai）
项目：Zone，Tauri 2 + React 18 + TypeScript
测试环境：Windows 11 专业版 10.0.26200；Node.js 24.19.0；Rust 1.94.1；1180×760／920×620 原生窗口。
实施基线：`b3dfcc8`；后续按聚焦功能／修复建立本地提交，未推送或发布。

## 交付范围

按已确认的功能和 UI/UX 检查顺序完成下表。正式客户端继续使用唯一主音频元素和受控 Rust 网络／文件入口，音乐与播客分别管理队列、进度和偏好。新增功能性文案为中文，保留 Zune 的排版、媒体封面与克制动效。

| 顺序 | 任务 | 完成的实现与行为 | 验证依据 |
| --- | --- | --- | --- |
| 1 | 刷新、下载和存储管理 | 应用生命周期内刷新；按最新 N 集安排自动下载；持久任务支持排队、暂停、失败、恢复；实际文件字节限制存储，未知／误报长度也执行上限；自动清理复核当前、待播、稍后听和手动列表保护 | 下载／维护 Rust 测试；完整客户端设置保存、暂停任务断点清理；故障注入下载与重启 |
| 2 | OPML 和完整备份 | 订阅导入去重、部分成功报告；OPML 导出；播客资料及可选下载音频备份；SHA-256 校验、按更新时间合并、失败回滚文件；拒绝无效进度与集合关系 | Rust 导入／备份测试；原生保存和打开流程；实际音频哈希与 SQLite 完整性 |
| 3 | 完整资料库搜索 | 查询完整数据库而非已加载页；节目内／跨节目搜索；未听、进行中、已听、下载、稍后听及历史筛选；最新、最早、标题、最近收听排序；分页、输入法组合与过期响应保护；目录失败时回退已关注及缓存资料 | 数据库搜索测试、React 运行时测试；完整客户端搜索空状态、清空及排序 |
| 4 | 每节目播放偏好 | 可继承默认设置或单独设置倍速、片头／片尾跳过、前进／后退间隔与播放顺序；等待偏好读取再绑定音源；显式时间码保留用户跳转位置 | 运行时竞态测试；原生解码、1.5 倍速、片头／片尾与 45 秒前进 |
| 5 | 阅读、转写与章节入口 | 安全简介富文本、公开链接、可点击时间码；VTT／SRT／JSON／TXT 转写解析、缓存、条件刷新、搜索及当前段跟随；与已有章节入口共用时间跳转 | 解析及安全测试；完整客户端真实音频时间码和缓存转写搜索／定位。章节入口沿用既有实现，本轮没有将外部章节源播放列为实机通过项 |
| 6 | 播放列表和节目分组 | 命名手动列表、智能条件列表、列表排序与播放；节目多组组织；删除集合保留节目、关注及音频；刷新裁剪保护被列表引用的单集 | Rust 列表／分组测试；完整客户端创建、加入、筛选、播放和删除 |
| 7 | 连接、系统媒体与睡眠恢复 | 实际时钟停滞检测、有限次数退避；离线等待恢复；暂停和切源使旧重试失效；前台恢复先检查睡眠截止时间；输出设备变化暂停；明确系统播放／暂停／定位不被切换去抖误吞 | 重连和时序测试；完整客户端原生媒体事件、焦点／online 后保持暂停；故障注入失败重试 |
| 8 | 音频增强、书签和分享 | 共用音频图的真实 PCM 音量均衡、静音段加速；暂停、定位、切源及异常收敛；时间书签与备注、跳转、删除；复制带时间单集链接 | AudioWorklet 算法／时序测试；真实 300 秒 WAV 的语音增益、静音 3 倍速与恢复 1.5 倍速；客户端书签和剪贴板 |
| 9 | 可选跨设备同步 | 默认关闭；用户选择已有共享目录后发布每设备原子快照，合并关注／取消关注意图及进度；有限设备数、格式／路径检查、损坏文件隔离与错误状态；不同步音频或队列 | 两份独立 SQLite 的同步测试；原生目录选择、立即同步落盘、停止同步 |
| 10 | 收听入口与列表可读性 | 剩余时长、上次收听时间、查看全部；可见更多操作；完整“继续收听”列表 | 完整客户端 1180×760 流程及更多菜单关闭 |
| 11 | 常驻播放底栏 | 倍速、睡眠设置和状态；直接打开待播；在线、已下载、本地离线状态按实际音源区分 | 完整客户端 920×620 底栏；公共 RSS 下载后的本地续听 |
| 12 | 发现信息可信度 | 来源和真实快照更新时间；排名与关注标记同时显示；空筛选仍保留来源；完整标题／作者可通过悬停和辅助技术读取 | 完整客户端排名缓存夹具；Apple／XYZRank 真实网络 smoke |
| 13 | 浏览和阅读层级 | 简介默认两行、可展开；压缩节目首屏；返回保留滚动、筛选、分页和单集焦点；主要动作与更多动作分层；简介、书签与转写互不重复 | React 返回／刷新测试；完整客户端返回、展开、时间跳转与唯一转写面板 |
| 14 | 资料库结构和数量语义 | 节目、单集、稍后听、下载、历史、管理分类；管理集中备份、同步和任务；历史未听完与近期更新分别标注 | 数据库历史筛选；完整客户端各分类入口和计数 |
| 15 | 待播完整反馈 | 已知剩余音频、按倍速预计时间、未知时长数量；当前单集默认收起；空状态入口；30 秒内撤销单次／批量移除及清空；后端比较实际队列再恢复；移动成功提示等待保存 | Rust 队列事务测试、运行时失败回滚；完整客户端移除／清空及撤销 |
| 16 | 键盘、最小窗口与减少动态效果 | 可访问动作名称、主题焦点反馈；搜索历史键盘选项；弹窗焦点隔离与 Escape 消费；最小窗口设置边距与常驻操作行；统一 reduced-motion | 两种真实窗口截图；真实 WebView2 媒体条件；原生客户端 Tab／Enter／空格／Escape |
| 17 | 完整客户端验收 | 正式构建产物加载完整 App、原生插件／命令／媒体协议；公共 RSS 播放、定位、下载、本地续播；进程重启；文件／目录选择；真实音乐与播客切换 | 下文客户端证据与原生故障测试 |
| 18 | 提交和报告 | 每个功能／聚焦修复独立本地提交；长期行为更新所属专题；本报告区分完整客户端、故障夹具和未覆盖硬件条件 | 提交记录、日志、结果 JSON 与截图 |

## 本轮最终验证

| 检查 | 结果 | 日志／证据 |
| --- | --- | --- |
| `npm test` | **552 通过，0 失败** | [前端测试日志](D:/Projects/zone/.tmp/podcast-final-queue-feedback-tests.log) |
| `npm run build` | **通过**，TypeScript 与 Vite 构建完成 | [前端构建日志](D:/Projects/zone/.tmp/podcast-final-queue-feedback-build.log) |
| `cargo check` | **通过** | [Rust 检查日志](D:/Projects/zone/.tmp/podcast-progress-validation-check.log) |
| `cargo test --lib --offline` | **207 通过，0 失败，7 默认忽略** | [Rust 全量测试日志](D:/Projects/zone/.tmp/podcast-final-rust-tests.log) |
| 显式 `ZONE_PODCAST_LIVE=1` 真实网络 smoke | **4 通过，0 失败**：Apple 中国区发现、封面代理、Apple→RSS→音频 Range、XYZRank→可播放 RSS 候选 | [真实网络测试日志](D:/Projects/zone/.tmp/podcast-final-live-tests.log) |
| `npx tauri build --no-bundle` | **通过**，生成正式 release 客户端；第三方许可 349 个组件核对通过 | [正式 Tauri 构建日志](D:/Projects/zone/.tmp/podcast-final-tauri-build-3.log) |
| 完整客户端主流程 | **19 组流程通过**，含音乐／播客双向切换 | [主流程结果](D:/Projects/zone/.tmp/podcast-client/2026-10-03T15-27-07.865Z-65492/result.json) |
| 公共 RSS 完整客户端 | **通过** | [公共网络结果](D:/Projects/zone/.tmp/podcast-client/2026-10-03T15-01-17.979Z-14596/result.json) |
| 完整客户端进程重启 | **通过**，当前单集、队列、进度恢复，启动保持暂停，实际音频继续 | [重启结果](D:/Projects/zone/.tmp/podcast-client/2026-10-03T15-02-40.350Z-38356/result.json) |
| 最终音乐切换后的再次重启 | **通过**，保留本轮最后的播客进度和队列，启动暂停并可续听 | [最终重启结果](D:/Projects/zone/.tmp/podcast-client/2026-10-03T15-28-43.877Z-70588/result.json) |
| 原生文件、目录与键盘 | **通过** | [原生交互记录](D:/Projects/zone/.tmp/podcast-client/2026-10-03T15-06-18.983Z-62984/manual-validation.json) |
| 原生故障与连续播放 | **通过**：200 次切源、10 轮故障恢复、下载取消／续传、播放与下载强制退出恢复、5 分钟连续播放 | [稳定性汇总](D:/Projects/zone/.tmp/podcast-stability/2026-10-03T15-18-01-986Z-70252/summary.json) |

7 个默认忽略测试中，4 个公共播客网络测试已单独显式运行通过；其余 3 个需要独立音乐格式／ALAC 音频夹具。本轮实际 WAV 音乐与播客播放已验证，但不能替代这些额外格式测试。

### 完整客户端与公共网络

完整客户端入口 `tests/run-podcast-client.mjs` 使用正式 `dist` 和完整生产 App 接线，复制 Rust 工程到隔离目录后加入测试驱动及截图接口。生产 CSP、capabilities 和公共 URL／DNS／重定向验证保持原样。测试使用独立应用身份及 `zone.sqlite`，未接触生产播放器资料。

公共网络验收通过原生客户端输入 [NPR News Now RSS](https://feeds.npr.org/500005/podcast.xml)，实际解析并关注节目，播放当日“10am ET, October 03 | The latest headlines from NPR”。验证受控在线媒体协议、音频时钟推进、60 秒定位、UI 下载、暂停意图、本地音频协议续播及再次暂停。浏览器离线事件用于检查恢复分支；本地播放协议绑定及实际时钟另行核对。该结果只说明本机此时网络环境可用，不代表全国运营商速度或所有节目 CDN 可达性。

主流程中的合成节目、排名缓存、转写及有声／静音 WAV 用于可重复行为检查；待播占位单集明确标注夹具并使用 `example.com`，未把它算作真实网络成功。此前组件预览审查也未作为完整客户端验收证据。

原生交互使用 computer-use 操作实际 Windows 保存／打开／目录选择窗口：OPML 重复导入报告为 0 新增、1 已有、0 失败；完整备份含一份 4,800,044 字节 WAV，SHA-256 为 `deda58c7d9945f5c6d7ed656cc0db442a2ba4e165677d8430a349606dcc93014`；恢复后 SQLite `integrity_check=ok`。目录同步生成每设备快照，停止后显示“同步未开启”。音乐目录扫描得到 1 首 300 秒 WAV，音乐时间实际推进，切回播客从原 30 秒位置续听并恢复 1.5 倍速。真实 Tab 的焦点可见，Enter 打开恢复文件选择器，空格恢复音乐，Escape 关闭底栏弹窗并返回底栏焦点。

### 原生故障注入与资源观察

正式播放 hook、数据库、下载器和媒体协议在独立故障服务器夹具中运行；仅测试源码副本允许访问该本地服务器。此夹具用于控制故障时序，完整 App 和公共网络另由上面的客户端验收覆盖。

- 200 次在线／离线切源和暂停续播只创建一个 AudioContext；10 轮 HTTP 503／连接中断恢复保留定位位置。
- 两种窗口尺寸下取消节流下载，键盘焦点与经过验证的断点文件保留；取消批量任务阻止余下单集开始；中断下载续传完成。
- 播放期间强制终止本轮隔离进程树，重启后默认暂停，恢复到约 132.98 秒；SQLite 完整性通过。
- 下载期间强制终止，重启后保留断点并完成 4,800,044 字节文件；SQLite 完整性通过。
- 连续播放约 300.11 秒，实际媒体时钟及持久化进度检查通过，AudioContext 数量为 1。29 次资源采样中，进程树私有内存首／尾中位数为 199.78／202.66 MiB，播放器主进程为 23.95／23.91 MiB，句柄首／尾中位数为 4235／4191。短测包含 WebView2 启动与缓存变化，这些数值不用于断言长时间无泄漏。

### 最终验收中发现并修复的问题

- 真实在线播放下载完成后，底栏曾显示“离线”，继续播放却仍绑定在线地址。已在暂停时切到本地音源，保存实际位置和暂停意图；在线播放不中断，文案区分“已下载”与实际“离线”。公共 RSS 重测通过。
- 媒体加载会把播放速率重置为 1。已在绑定和元数据完成后应用节目速率，真实客户端验证 1.5 倍速。
- 定位后的显式系统暂停曾被媒体控制去抖误吞。明确播放／暂停／定位指令现在始终接受，原生媒体事件测试通过。
- 单集阅读区域重排后，书签和转写曾使用重复组件 key，进度更新可能复制转写面板。已使用独立 key，客户端检查仅保留一个面板。
- 最小窗口的设置弹窗和节目首屏曾挤占过多垂直空间。已缩减留白、保留弹窗边距和常驻操作行，920×620 截图复核通过。
- 队列移动的成功提示曾先于后端保存。现在等待保存且确认仍为同一队列版本，失败恢复实际顺序并提示错误；故意写入失败测试通过。
- 备份恢复补充进度边界、集合关系、文件校验及失败回滚；下载上限和自动删除在实际写入／事务时重新核对保护条件。

音乐切换回归驱动补齐了“已播完夹具先重置为未播放，再定位到 45 秒”的前置条件，并按照客户端实际恢复的单集详情页继续操作。早期驱动失败轮保留在本地证据中，没有计入最终通过结果。

## 适用边界

- 本轮连续播放为 **5 分钟**，并运行 200 次切源及故障／强制退出恢复。更长时间运行可复用已有默认 120 分钟稳定性入口；本报告不将短测等同于数小时稳定性证明。
- 真实 WebView2 的 reduced-motion 媒体条件已验证；未修改 Windows 系统动效设置。网络断开／恢复事件和原生媒体桥接事件已覆盖，未把它们描述为实际拔网线、系统 S3／S4、物理媒体键或蓝牙设备切换。
- 音频均衡使用真实 PCM 的 RMS 和有限增益，静音加速使用阈值检测；当前不是 EBU LUFS 响度分析或语音识别。
- 目录同步已验证两份独立数据库合并及原生本地目录流程。网盘或共享盘的传输由所选存储服务负责，本轮未验证具体云服务或跨公网文件复制。
- 备份恢复会立即合并资料，前端播放设置按 UI 提示在重启后重新载入。时间链接能否直接定位，取决于接收链接的播放器。

## 本地证据与复测

代表性截图：

- [最小窗口节目首屏](D:/Projects/zone/.tmp/podcast-client/2026-10-03T15-27-07.865Z-65492/04-show-search-920.png)
- [单集简介与同步转写](D:/Projects/zone/.tmp/podcast-client/2026-10-03T15-27-07.865Z-65492/07-notes-transcript-920.png)
- [底栏播放选项](D:/Projects/zone/.tmp/podcast-client/2026-10-03T15-27-07.865Z-65492/12-bar-options-920.png)
- [减少动态效果与最小窗口设置](D:/Projects/zone/.tmp/podcast-client/2026-10-03T15-27-07.865Z-65492/16-reduced-motion-settings-920.png)
- [公共 RSS 下载后本地播放](D:/Projects/zone/.tmp/podcast-client/2026-10-03T15-01-17.979Z-14596/31-public-download-offline.png)
- [原生完整备份恢复](D:/Projects/zone/.tmp/podcast-client/2026-10-03T15-06-18.983Z-62984/21-manual-1.png)
- [目录同步完成](D:/Projects/zone/.tmp/podcast-client/2026-10-03T15-06-18.983Z-62984/21-manual-2.png)
- [真实音乐播放](D:/Projects/zone/.tmp/podcast-client/2026-10-03T15-06-18.983Z-62984/21-manual-3.png)
- [音乐切回播客续听](D:/Projects/zone/.tmp/podcast-client/2026-10-03T15-06-18.983Z-62984/21-manual-4.png)

日志、截图与测试数据库为本机 `.tmp/` 证据，不纳入正式源码。长期行为和测试入口见 [播客子系统](D:/Projects/zone/design/engineering/podcasts.md)。

复测：先 `npm run build`，再 `npm run test:podcast:client`；公共网络／重启／原生交互模式见专题中的环境变量说明。故障与短时间连续播放使用 `npm run test:podcast:stability -- --minutes=5 --cycles=200`，较长连续播放使用既有默认入口。真实网络 smoke 需显式设置 `ZONE_PODCAST_LIVE=1`。

## 实施提交

| 提交 | 内容 |
| --- | --- |
| 91b45a0 | feat: Add durable podcast downloads and background maintenance |
| ddf3df2 | feat: Import and export podcast subscriptions with OPML |
| 92f3ec3 | feat: Back up and merge podcast data with verified audio |
| c8c1c2b | fix: Keep Escape within the active dialog |
| b6dc142 | feat: Search and filter the complete podcast archive |
| 4d8f67d | feat: Apply per-show playback preferences to podcast transport |
| b457ecb | feat: Add safe podcast notes and synchronized transcripts |
| 4a7738e | feat: Add named and smart podcast playlists |
| 3a43068 | feat: Organize followed podcasts into show groups |
| 51e117c | fix: Recover podcast connections without reviving paused playback |
| 3921f21 | fix: Enforce podcast storage budgets and protected cleanup |
| 5d78cca | fix: Preserve explicit system media commands after seeking |
| 7770f67 | feat: Level podcast voices and accelerate real silent segments |
| 5e3e0f8 | feat: Save podcast timestamp bookmarks and share listening moments |
| f9b40c6 | fix: Roll back podcast backup media and validate restored collections |
| 228192f | feat: Merge podcast subscriptions and progress through a shared folder |
| e1ec229 | feat: Expose complete listening lists and visible episode actions |
| 8216f6e | feat: Add persistent podcast playback options and queue navigation |
| 6198fc8 | feat: Clarify podcast discovery sources and ranking metadata |
| 7b5b732 | feat: Preserve podcast browsing context and simplify episode reading |
| 2a5a29b | feat: Organize the podcast library into focused sections |
| dba023b | feat: Show podcast queue timing and safely undo removals |
| 1ff39ab | fix: Validate listening times before merging podcast snapshots |
| ed417ca | fix: Improve podcast keyboard access and compact window layouts |
| 6df615f | fix: Resume completed podcast downloads through local audio |
| ee67d89 | fix: Confirm podcast queue movement before announcing success |
| 94b1b5e | test: Verify complete podcast client networking and native workflows |
