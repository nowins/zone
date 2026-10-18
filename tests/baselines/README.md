# 原生截图候选与性能观察

本入口复用真实 CI release exe 和 `tests/run-native-artifact.mjs`，不替换前端、增加原生测试命令或扩大 Tauri 权限。`npm run test:ci:baselines -- --manifest <v2清单> --driver <匹配驱动> --report <新的目录>` 在普通 smoke 中追加候选采集；工作流在一次性 Windows runner 上执行。当前任务的本机启动暂停约束仍有效，不因新增命令而解除。

场景参数与测量事实源为 `tests/native/nativeBaseline.mjs`，图片及批准守卫为 `baselineSupport.mjs` 和 `scripts/qa/compare-native-baselines.mjs`。

## 固定场景

- 两个由已有 `writeWave` 生成的 2 秒 PCM WAV，名称为 `CI Sample One/Two`；真实扫描、SQLite、一个喜欢项目及 `CI 持久化列表`。结果保存音频哈希和来源／exe SHA。
- 收藏“歌曲”页，原生客户区分别为 1180×760 和 920×620；只对准确 PID、exe 路径和内嵌 CI 身份均匹配的窗口调整大小，不改桌面分辨率或系统 DPI。实际 `innerWidth/innerHeight` 不符时失败，不用虚拟 viewport 冒充原生尺寸。
- 通过 Edge CDP 模拟减少动态效果和浅色偏好，核实真实应用响应；页面本身必须是浅色、暂停状态、两首指定歌曲、字体就绪且区域内无运行中的动画。移走鼠标并清除焦点，排除悬停和光标闪烁。
- 稳定区域从收藏工具栏到第二首歌曲下方，排除原生窗口控件、播放条、封面与动态频谱。保留完整截图用于定位，裁剪图用于比较；不靠隐藏功能性文字或注入假音频稳定画面。
- 每个尺寸重复采集两次，像素必须完全一致才标记 `captureStatus=repeatable`。这只证明本次候选可重复，`visualReview` 仍为 `pending`，不能称为视觉回归已通过。

runner 桌面可能小于默认窗口。若桌面最大跟踪尺寸收窄了目标客户区，只对已核对的 CI 窗口采用 `SWP_NOSENDCHANGING` 保留离屏客户区，仍以真实 DOM 尺寸和截图边界核实；报告记录 `desktopOverflow`／`desktopTrackingOverride`。这验证窗口布局和完整客户区捕获，不代表该小桌面的全部可见性或操作体验，不修改桌面分辨率。相关行为见 [WM_WINDOWPOSCHANGING](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-windowposchanging) 与 [SetWindowPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos)。

## 性能口径

在同一暂停小夹具、真实 1180×760 客户区上，排除一次预热后各取 7 个样本：正式 `music_get_library_snapshot` 的渲染器往返；从播放列表 DOM 点击到两首歌曲出现并经过两帧。计时在 WebView2 内使用 `performance.now`，不含 WebDriver HTTP 延迟。记录采样实际窗口、原始样本、数量、中位数、p95、min/max、OS、CPU、内存、runner 镜像、WebView2 UA、DPI 和字体度量；采样期间窗口变化时拒绝结果。

结果为 `performanceVerdict=observed`，没有默认产品阈值。7 个样本的 p95 是该小样本的上端观察值，不代表统计容量结论；不推断大曲库、冷启动、默认动效、真实输入设备或长期稳定性。比较报告可以并列参考数值，但当前不以未校准耗时判断产品失败。

## 经审阅参考的比较

`npm run qa:compare-baselines -- --candidate <候选result.json> --reference <reference.json> --output <独立临时目录>` 输出 `comparison.json` 和差异热图。退出码：0 为匹配已批准参考与其容差，1 为比较失败／无效证据，2 为待审阅或环境不兼容；性能始终只是观察。没有 `--accept` 或自动更新参考入口。

批准参考需要保留完整候选 `result.json` 与其同目录 PNG，并建立以下描述。示例明确为未批准；只有实际审阅后才能填写批准人、时间、候选 JSON 的 SHA256 和明确像素容差，不得由 AI 自行改成 approved：

```json
{
  "format": "ZoneNativeBaselineReference",
  "version": 1,
  "candidate": "result.json",
  "candidateSha256": "待核对候选JSON哈希",
  "review": { "status": "pending", "reviewer": "", "reviewedAt": null },
  "limits": { "perChannelTolerance": 0, "maxChangedPixelRatio": 0 }
}
```

比较前核对已审阅 JSON 与 PNG 的实际哈希；输出不得写进参考目录。OS、镜像、WebView2、字体、DPI、主题、窗口或夹具变化时报告 incompatible，不能把渲染环境漂移算成产品回归或直接接受新图；同环境下区域几何或像素变化按已批准容差比较。当前已批准参考见 [approved/README.md](approved/README.md)，其 JSON 与 PNG 保留采集时的原始字节；批准状态以 `approved/reference.json` 为准。

若将正式批准参考放在 `tests/baselines/approved/reference.json`，CI 才运行比较步骤；缺少时只上传候选并在摘要写明 review pending。所有候选和报告在原生 smoke 的 `baselines/` 下，随诊断保留 7 天；结果不是完整 UI／键盘／动效验收。

图片工具使用 Windows 自带 System.Drawing，测试生成真正的 PNG，验证裁剪越界、像素变化、哈希篡改、未审阅参考及窗口归属拒绝。它们是工具守卫，不冒充应用截图比较已通过。

技术依据：[Edge CDP 与减少动态效果](https://learn.microsoft.com/en-us/microsoft-edge/devtools/accessibility/reduced-motion-simulation)、[Selenium 的 Edge CDP 路由](https://github.com/SeleniumHQ/selenium/blob/trunk/py/selenium/webdriver/chromium/remote_connection.py)。
