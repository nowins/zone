# 已批准的原生视觉参考

本组参考由用户在 2026-10-18 14:59:13（北京时间）明确批准，原话为：“批准两张候选，采用零容差”。批准对象为原生收藏“歌曲”页在 1180×760 和 920×620 客户区下的两个裁剪区域；完整截图和重复采集图仅保留作定位与复核。批准人字段使用“用户（当前会话明确批准）”，不推定 GitHub 账号身份。

## 来源与完整性

- [Windows CI 39079355797](https://github.com/nowins/zone/actions/runs/39079355797)，[诊断产物 12118293527](https://github.com/nowins/zone/actions/runs/39079355797/artifacts/12118293527)。
- 采集源码：`64bd1a427408fc6a543aca3e86b03415cab868ee`。审查时 main 为 `89cf90ae016613b2c3cccb50b501812b9de32b6c`，二者 Git tree 均为 `5283249df0e8c8282233c84116cf53efd57431be`。
- EXE SHA-256：`e7cbe595c31c95a714e800595d8ffed2bead36d421eacade446644de8d873655`。
- 原始 `result.json` SHA-256：`7d972e0a88c7558e0c7856afadffda9a7d9e5de5d756796720858af8f4d14d45`。
- 候选 JSON 和全部 PNG 保留原始字节；`result.json` 的 `visualReview=pending` 是采集时状态，不改写历史证据。当前人工批准记录位于 `reference.json`。
- `.gitattributes` 为 `result.json` 关闭文本换行转换，确保 Windows 的 `core.autocrlf` 不改变已批准文件的 SHA-256。首次 PR CI 因 LF 被检出为 CRLF 而被哈希守卫拒绝；修复仅固定检出字节，不更新候选、批准哈希或像素容差。

| 场景 | 比较区域 | PNG SHA-256 |
| --- | --- | --- |
| songs-1180x760 | x=36，y=84，1108×210 | `2ec1eb8cb8271f74aac4783e48264f9e9bfaabbf7fa53f600b56fcf5145bc2dd` |
| songs-920x620 | x=28，y=84，864×210 | `9fe780347372371a7a244e0c1e8048ec79a884b1f41091f175a1ee2ee4c351cb` |

两场景均为浅色、暂停、减少动态效果、两首生成 WAV、第一首喜欢；DPI=96，DPR=1。与较早 CI 39004860585 的对应裁剪 PNG 字节完全一致，各次重复采集也无像素差异。人工批准前已核对 ZIP digest、EXE 与清单、PNG 哈希、完整图和裁剪关系、夹具及主线源码。

## 比较与环境边界

`reference.json` 固定 `perChannelTolerance=0`、`maxChangedPixelRatio=0`。现有 Windows CI 检测该文件后执行既有比较步骤，无需增加平台、修改应用或放宽判断；任何像素变化仍须审查，没有自动接受入口。

本参考记录 Windows `10.0.20348`、win22 镜像 `20261012.333.1`、WebView2 `131.0.2903.86`、AMD EPYC 7763 及原始字体度量。CPU 型号保留在原始报告中作诊断，比较器仅在判定硬兼容性时排除 `compatibility.renderer.cpu`，不改变报告、哈希、截图或审批记录。CI 39116081809 的 AMD EPYC 9V45 与本参考仅 CPU 不同，诊断 ZIP SHA-256 为 `1c0b942a5e9e1bb0dc249e6114d2e28e5de346c1d76ddd766676d467da126832`，两张裁剪 PNG 均与参考字节相同；这支持将 CPU 视为诊断信息，不推断所有 CPU 都必然产生相同像素。Windows、架构、runner 镜像及版本、WebView2、字体、DPR／原生 DPI、主题、窗口和夹具仍严格匹配，其他未知兼容性字段也不忽略。任何实际像素变化继续按零容差失败；镜像或浏览器漂移仍报告 `incompatible`，不得自动重采集并批准来消除门禁失败。

1180×760 客户区超出 runner 的 1024×768 桌面；实际 DOM 与完整 PNG 尺寸已核对，未使用桌面跟踪覆盖。这覆盖布局与捕获，不代表该桌面上的完整操作体验。

仅裁剪区域受本次批准保护，不包含窗口控件、播放条、封面与动态频谱，不代表深色、高 DPI、大库、正常动效、全部键盘、真实音频或安装验收。性能仍为 `observed`，没有产品性能门槛。

在匹配环境的 Windows 项目根目录复核：

```powershell
npm run qa:compare-baselines -- --candidate tests/baselines/approved/result.json --reference tests/baselines/approved/reference.json --output .tmp/approved-baseline-self-check
```

这是对已批准证据及比较工具的自比较；未来提交的真实界面仍由 CI 新采集后与本组比较。自比较不替代未来构建验证。输出目录必须位于参考目录之外。
