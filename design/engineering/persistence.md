# 音乐持久化、曲库扫描与诊断

本文由根目录 [AGENTS.md](../../AGENTS.md) 按任务索引引用。文中的行为与安全边界适用于相关改动；标为当前实现的参数用于定位，可在验证后调整。代码路径均相对于仓库根目录。

## 数据边界

- 音乐主状态存于应用数据目录的 `zone.sqlite`（`src-tauri/src/db/` + `music/`）；`zone-player-state-v1` 仅作为旧版迁移源。只有原生导入提交并返回读取快照、且成功保存 `-backup` 后才删除旧键。恢复失败时保留原始数据，并暂停自动数据库写回。
- 诊断导出包含应用版本、Git 构建标识和精简运行环境，以及最多 200 条结构化事件；读取旧记录时同样执行字段校验，不导出原始错误、音乐路径、曲目信息或订阅地址。版本一致性由 `packaging/check-version.mjs` 在构建与测试入口校验，发布步骤见 [安装与发布](../../packaging/README.md)。
- 单实例插件在其他插件和数据库初始化前注册；再次启动只显示、还原并聚焦已有窗口，避免多个实例用旧快照互相覆盖歌单、磁贴和队列。托盘隐藏和最小化都须能唤回。
- 曲库 schema 版本为 `LIBRARY_SCHEMA_VERSION`（当前 6）。
- 旧 SQLite 迁移的全部表、兼容补列和完成标记在同一事务提交。没有完成标记时，已有部分行不代表迁移成功，仍须幂等补齐其余数据。提交后用 SQLite 一致快照归档（包含 WAL），保留既有备份；归档失败保留原库，重启继续归档而不重导入。
- 喜欢的歌曲是 id 为 `DEFAULT_PLAYLIST_ID`（`favorites`）的默认播放列表；读取播放列表状态时必须用 `normalizePlaylists`，补齐默认列表并统一显示名，保留原 ID 和歌曲顺序。分类“收藏”仍指整个本地音乐库。对象浏览历史仅在会话内保存，不建立第二份持久媒体库。
- home pins 用 `normalizeHomePins`/`reconcileHomePins` 做归一化与对账。`music_home_pins` 保存顺序及可选的 `size`／`live`／`tone`；缺失尺寸按内容类型回退，缺失外观按封面与动态开启处理。数据库原位补列保留旧固定项，替换整组磁贴与 revision 更新在同一事务中，任意插入失败都保留原来的墙。尺寸／颜色枚举在前端归一化并由 Rust 校验。

歌词与播客的数据键、迁移和删除规则分别见 [歌词](lyrics.md) 与 [播客](podcasts.md)，不能把不同类别的状态合并清理。

## 扫描与诊断

- 曲库扫描由异步 `music_scan_library` 在 `spawn_blocking` 中串行执行，通过 `Channel<usize>` 上报已读取曲目数；`music_cancel_scan` 使当前任务失效。取消时不得提交部分曲库结果。
- 清空音乐库须确认，扫描中禁用。先暂停前端自动保存并等待在途写入，原生取消并串行等待扫描，再在一个事务中清除音乐状态；失败保留原状态并允许重试。仅成功后清空前端，保留播客磁贴、播客资料和音频文件。
- 扫描全部来源成功后才提交。目录离线、遍历失败或音频不可读时返回失败并保留完整快照、队列和固定项；不能把不完整扫描当作空曲库。正常可访问的空目录仍可确认删除。前端保留已知曲目的历史统计，曲目重新出现时复用，只有明确清空时重置。
- `zone-diagnostics-v1` 只保留最近 200 条本地结构化事件（播放尝试、媒体错误、预分析和保存结果），不存原始错误、文件路径或 RSS URL。设置中的导出由原生 `export_diagnostics` 保存对话框完成。音乐保存失败显示可重试反馈。

## 代码入口

- `src/App.tsx`：数据库快照恢复、旧状态迁移与自动写回的接线。
- `src/app/musicLibraryApi.ts`：音乐原生命令接口；`src/utils/legacyMigration.ts`：前端迁移门闩；`src/utils/diagnostics.ts`：诊断缓冲。
- `src/hooks/useMusicLibrary.ts` / `useLibraryWatcher.ts`：扫描状态、取消与目录变化刷新。
- `src-tauri/src/db/`：音乐数据库与 schema；`src-tauri/src/music/store.rs` / `commands.rs`：快照、迁移、扫描与命令；`src-tauri/src/library.rs`：文件扫描和标签读取；`src-tauri/src/diagnostics.rs`：诊断导出。

## 验证

- 前端变化运行 `npm run build` 与 `npm test`，重点覆盖 `tests/legacyMigration.test.mjs`、`tests/diagnostics.test.mjs`、`tests/libraryWatcher.test.mjs` 与播放列表/固定项归一化测试。
- Rust 变化运行 `cargo check`，迁移、取消与数据库行为补充并运行对应 `cargo test --lib` 测试。
- 迁移必须覆盖失败时旧数据保留、备份写入失败、成功后重启不会重复导入；扫描覆盖取消后不提交部分结果与连续扫描不会相互覆盖。
- 交互变化检查扫描进度/取消、保存失败提示和重试；诊断导出不能泄露原始路径或 URL。
