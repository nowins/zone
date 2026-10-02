export const PRIVACY_SECTIONS = [
  { title: "本地资料", text: "音乐索引、歌单、喜欢、播放统计、播客订阅和进度保存在这台电脑。Zone 不上传音乐文件，也不提供账户或云同步。补充资料保存在本地，采用补充结果不会改写音乐文件。" },
  { title: "在线来源", text: "在线歌词和资料补充默认启用。查询时会向已启用的来源发送曲名、歌手、专辑，以及匹配所需的时长；来源包括 QQ 音乐、网易云音乐、LRCLIB、AMLL TTML DB 和 Apple。可在设置中分别关闭。" },
  { title: "播客与网络", text: "浏览播客目录、搜索、刷新订阅、播放或下载时，会连接 Apple 目录、订阅源以及节目提供方的音频和图片服务。网络服务可获得请求内容和你的网络地址，其处理方式由对应提供方决定。" },
  { title: "Windows 组件", text: "界面使用 Microsoft WebView2，包含 Microsoft Defender SmartScreen，会按微软的设置收集并发送安全检查等相关信息。系统运行时由微软自动更新，包内离线运行时随 Zone 更新。详情见微软隐私声明与 Edge 隐私白皮书。" },
  { title: "诊断与清理", text: "Zone 不自动发送诊断记录。手动导出的记录包含应用版本、构建标识、运行环境和最多 200 条结构化事件，不包含音乐路径、歌曲信息、订阅地址或原始错误文本。清空音乐资料库会移除音乐索引及用户状态，保留播客和电脑中的音乐文件。MSIX 卸载会清理包内资料，独立安装版本可能保留应用数据；卸载不会删除你的音乐源文件。" },
] as const;

export const PRIVACY_LINKS = [
  { label: "微软隐私声明", url: "https://privacy.microsoft.com/privacystatement" },
  { label: "Edge 隐私白皮书", url: "https://learn.microsoft.com/microsoft-edge/privacy-whitepaper#smartscreen" },
] as const;
