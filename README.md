# GuitarFlow 吉他流

跨平台吉他谱跟练应用，一套 TypeScript 代码同时产出 **Windows 安装包 / Android APK / iOS IPA**。

- 谱面**跟随演奏滚动**：要么跟伴奏走，要么用麦克风听你弹、谱面跟着你走
- **每个音符都有对应的音高声音**：Karplus–Strong 物理建模拨弦，按真实弦长/品位计算基频
- **内录 + 实时音高检测**：麦克风音高条、音准偏差（音分）、命中统计、卷轴式音高轨迹；移动端在播放条上常驻音高徽标
- **多源搜谱**：免费站点聚合 + 吉他世界（含直链推导）+ 本地曲库模糊检索
- **智能导入**：Guitar Pro / MusicXML / MIDI / ASCII 六线谱 / ChordPro / PDF / 图片，统一转成可滚动、可点播、可发声的谱
- **点击谱面跳转进度**、自动滚动、变速 0.5×–1.5×、节拍器

## 为什么是这套技术栈

| 需求 | 方案 |
| --- | --- |
| 三端一次开发 | React + Vite 单页应用；Windows 用 Electron，iOS/Android 用 Capacitor 包同一个 `dist/` |
| 专业六线谱排版 / GP 文件 | [alphaTab](https://alphatab.net) 负责解析 GP3–GP8、MusicXML、alphaTex 与 SVG 排版 |
| 逐音符发声、可自定义音色 | 自研 Web Audio 合成器（不依赖 soundfont，安装包更小） |
| 实时音高 | 自研 AudioWorklet：FFT 自相关（Wiener–Khinchin）+ 抛物线插值，主线程 YIN 兜底 |
| 内录 | `OfflineAudioContext` 离线重渲染 → WAV；桌面端另有系统 loopback 采集 |
| 进度与光标 | 自研时间轴 + `boundsLookup` 坐标映射，不依赖 alphaTab 播放器 |

## 目录结构

```
src/
  core/       数据模型、IndexedDB 曲库、模糊检索、平台桥接、曲库备份
  audio/      合成器、播放器、音高检测、录音（含 worklet）
  score/      时间轴构建、跟随对齐、图片谱时间轴
  import/     和弦指法库、ASCII/ChordPro/MIDI/PDF 转换器、统一导入入口
  sources/    谱源适配层（吉他世界、UG、91谱、17吉他、Songsterr、ChordPro 仓库）
  ui/         曲库 / 搜索 / 导入 / 谱面 / 练习面板 / 传输条
electron/     桌面主进程与 preload（本地文件、无 CORS 请求、系统内录）
scripts/      资源复制、原生权限补丁、构建产物冒烟测试
tests/        解析器与检索的单元测试（vitest）
.github/      Android / iOS / Windows 三条打包流水线
```

## 本地开发

```bash
npm install          # postinstall 会把 alphaTab 字体复制到 public/font
npm run dev          # 打开 http://127.0.0.1:5173
npm test             # 解析器单元测试
npm run build        # 类型检查 + 生产构建
npm run preview      # 预览构建产物
```

桌面端调试（需要本机已下载 Electron 二进制）：

```bash
npm run electron:dev
```

## 出安装包（GitHub Actions）

> 第一次操作请照 [docs/GITHUB.md](docs/GITHUB.md) 一步步点：建仓 → 上传 → 等 Actions → 下载安装包。


推送到 `main` 或打 `v*` 标签即可，三条流水线互不影响：

| 流水线 | 产物 | 说明 |
| --- | --- | --- |
| `.github/workflows/android.yml` | `app-debug.apk`、`app-release.aab` | 另含 GitHub Pages 部署；配置 `ANDROID_KEYSTORE_BASE64` 等 secrets 后自动签名 |
| `.github/workflows/ios.yml` | `GuitarFlow-unsigned.ipa` | macOS runner 上 `xcodebuild` 归档；正式分发需自备证书与 profile |
| `.github/workflows/windows.yml` | NSIS 安装包 + 便携版 exe | `electron-builder` |

iOS 签名三步（可选）：把 `.p12` 证书 base64 存为 `IOS_CERT_P12`、mobileprovision 存 `IOS_PROFILE`、团队 ID 存 `IOS_TEAM_ID`，然后把流水线里的归档步骤换成 `xcodebuild -exportArchive`。

## 谱源说明

| 源 | 能力 | 备注 |
| --- | --- | --- |
| 吉他谱 jita5 | 搜索 + 详情 + 页图 | 免费；GBK 页面已做编码处理，图片域 `img.jita5.cn` |
| 吉他之友 798 | 搜索（带 formhash）+ 论坛帖页图 | 免费；Discuz 结构，帖内图片抽取 |
| Ultimate Guitar | 搜索 + 文本谱 | 免费；抓 `wiki_tab.content` 清洗后转成可播放谱 |
| 91谱 / 17吉他 | 搜索 + 页图 | 免费图片谱，进入打点同步模式 |
| ChordPro 曲库 | GitHub 仓库检索 | 在「谱源设置」填 `owner/repo` 后启用，完全可播放 |

> 付费/会员型谱源（原「吉他世界」「Songsterr」）已移除。

> 抓取逻辑都集中在 `src/sources/providers/`，新增一个源只需实现 `search()` 与 `load()` 两个方法，再 `registerProvider()` 注册。

## 导入格式

| 格式 | 处理方式 | 结果 |
| --- | --- | --- |
| `.gp3/.gp4/.gp5/.gpx/.gp7` | alphaTab 原生解析 | 完整谱面 + 指法 |
| `.musicxml/.xml` | alphaTab 原生解析 | 完整谱面 |
| `.mid/.midi` | `@tonejs/midi` → alphaTex | 单/多声部合并为和弦，自动分配弦品 |
| 六线谱文本 | `src/import/asciiTab.ts` | 和弦列合并、按列距推断时值、按小节切分 |
| ChordPro `.cho/.crd` | `src/import/chordpro.ts` | 和弦指法库生成真实下扫音，`{capo}` 生效 |
| `.pdf` | 文本层能还原六线谱则转换，否则渲染页图 | 可滚动谱 / 图片谱 |
| 图片 | 页图 + 打点同步 | 手动把播放时间绑定到页 |

图片谱的「打点同步」：进入阅读器后点页面跳页，播放到该页时按打点按钮记录时间，之后自动滚动即按你的打点走。

## 自检脚本（本机已验证）

```bash
npm run build
npx electron --version || true          # 桌面打包需要本机 Electron 二进制

node scripts/serve.cjs &                # 起静态服务 http://127.0.0.1:5123
node scripts/cdp-smoke.mjs              # 渲染 + 播放 + 自动滚动 + 点击跳转
node scripts/cdp-import.mjs             # ASCII / ChordPro 粘贴导入 → 可播放
node scripts/cdp-pdf.mjs                # 真实 PDF / 图片导入（需工作区里有样例文件）
node scripts/cdp-mobile.mjs             # 430×932 移动端布局 + 麦克风音高
node scripts/cdp-follow.mjs             # 「跟我弹」：用 82.4Hz 音频模拟 E2
```

这些脚本用本机 Chrome 的 CDP 驱动真实页面，输出 JSON 结论与截图，不引入额外测试框架。

音高检测相关细节：

- 起音即上报（连续 3 帧、约 70ms 稳定），所以「跟我弹」按弦就会推进，不必等音结束
- 去掉了「半周期倍频纠错」，纯音/基频强的信号不会被误判成高八度
- 输入 RMS 低于 0.0015 视为噪声，避免空房间误触发

## 录音（对照参考 App）

参考的《音高》APK 是 Flutter 应用，拆包可见其链路为：
`record_android`（AudioRecord 录 PCM）→ `FFmpegKit + LAME` 编码 → `audioplayers` 回放。

本项目用等价链路，且不依赖原生插件：

- `PcmRecorder`：直接抓麦克风原始采样（避开 MediaRecorder 在各平台格式不一的问题）
- 录音时同步播放曲谱；停止后写入 **录音库**（IndexedDB）
- 导出 **WAV**（无损）或 **MP3**（lamejs，纯 JS LAME，与参考 App 同款编码器思路）
- 另保留「内录当前曲目」：离线渲染应用自身音源 → WAV，适合没有麦克风时保存成品

## 本机曲库

`G:\吉他谱1` 里的 2505 张谱图（521MB）不会塞进安装包，而是：

1. `scripts/build-library.mjs` 扫描目录生成索引（当前 916 首 / 2505 张，155KB 打进应用）
2. 应用里点「连接文件夹」选一次目录，按需把某首歌的页图读进曲库（只复制这一首，约 1MB）

重新生成索引：

```bash
node scripts/build-library.mjs --src "G:\吉他谱1"
```

## 图片 / PDF 识谱（Beta，如实说明）

`src/import/omr/` 实现了六线谱图片识别：

- **稳定部分**：灰度/Otsu 二值化、弦线检测（长横线 run）、六线谱表分组、符干擦除（避免把和弦粘成一个连通域）、连通域取字形、按 x 坐标铺成 ASCII 六线谱
- **不稳定的部分**：品位数字分类。同一页字体一致，采用 k-means 聚类 + 模板贴标签，但印刷体差异、简谱/和弦图干扰仍会造成误读
- **因此定位为「初稿 + 人工校正」**：识别结果直接显示成可编辑文本，改错后再生成可滚动曲谱。导入页里是「图片 / PDF 识谱（Beta）」面板
- 导入页仍保留图片谱模式的「打点同步」，扫描件、手写谱优先走这条路

后续可换 Tesseract/自训练小模型提升准确率；现在的实现至少把「谱表几何」和「可校正流程」跑通了。

## 已知限制

- alphaTab 社区版会在谱面右上角显示水印；商用需要其商业授权。
- 图片识谱目前是 Beta：系统/弦线检测稳定，数字识别需要人工校对（UI 已支持）。
- 本机曲库每次重启后需重新「连接文件夹」（浏览器安全限制），Electron 端后续可持久化路径。
- iOS 的无签名 IPA 只能自签（AltStore/TrollStore/开发者证书）后安装；TestFlight 需付费开发者账号。
- 麦克风音高检测在 55–1400Hz 内最稳，失真音色或过低音会掉帧；检测不到时会自动跳过而不是误判。
- 吉他世界之外的谱站页面结构随时可能变，解析失败会在「搜谱」页明确提示，不会静默失败。

## 隐私

麦克风音频只在本机内存里做音高分析，不上传、不落盘；只有你主动点「保存录音」才会写出音频文件。曲库存在本机 IndexedDB。