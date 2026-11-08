# GuitarFlow 吉他流

跨平台吉他谱跟练与内录测音高应用，一套 TypeScript 代码同时产出 **Windows 安装包 / Android APK / iOS IPA**。

- **免费多源搜谱（已彻底移除全部付费谱源）**：内置 **吉他屋 (jita5.cn / jita5.cc)**、**吉他之家 (798com.com)**、**17吉他网 (17jita.com)**、**虫虫吉他 (ccguitar.cn)**、**吉他社 (jitashe.org)**、**爱曲谱网 (2qupu.com)**、**吉他网免费专区 (jita.com)**、**Ultimate Guitar** 与 **GitHub 开源曲谱库** 共 9 大免费谱源，导入时自动识别为可滚动曲谱
- **PDF / JPG / PNG 高精度曲谱识别与转换（OMR）**：
  - 自动完成彩色印章/水印抑制、6 弦谱表与小节竖线定位、**谱表上方和弦指法图（C/G/Am/Em/F/D 等 6弦×4品网格）几何识别**、逐弦局部抹线、拓扑+分区密度品位分类（0–9 与 `×` 伴奏音型自动还原为对应和弦品位）以及符尾横梁时值推断（`:4` / `:8` / `:16` / `:2`）
  - 拖入 PDF（文本版或扫描版）或单张/多张 JPG、PNG、WebP 曲谱图片，**直接转换为可滚动、可点击跳转、逐音符发声的交互六线谱**，并在阅读器顶部支持随时切换「🎵 可滚动六线谱 / 👁 原谱图片对照」
- **《音高》App 同款多源内录与音高曲线分析**：
  - **应用内实时内录（`app-live`）**：直接挂接 `GuitarSynth` 内部总线录制零杂音演奏音频
  - **内录伴奏 + 麦克风混录（`mix-live`）**：伴奏内录与麦克风弹唱实时混音录制
  - **系统级跨应用内录（`system-loopback`）**：Windows/Electron 系统 loopback 与 Android 10+ 原生 `AudioPlaybackCaptureConfiguration + MediaProjection` 跨应用内录，录制系统或其他音乐 App 声音的同时实时检测音高并驱动跟谱
  - **全曲高速离线内录（`offline-render`）**：基于 `OfflineAudioContext` 秒级导出整首曲谱音频
  - **《音高》风格音高轨迹与音域图**：支持对任意内录/录音或外部导入的音频文件（MP3/WAV/M4A）提取逐帧音高曲线、最低音~最高音音域范围、平均音准偏差（`±¢`）与波形包络，支持 LAME **MP3**（160kbps）与无损 **WAV** 导出

## 免费谱源列表

| 谱源 ID | 站点名称 | 网址 | 能力说明 |
| --- | --- | --- | --- |
| `jita5` | 吉他屋 jita5 | `https://www.jita5.cn/` / `https://www.jita5.cc/` | 免费高清弹唱/指弹谱，整页抓取并自动 OMR 转可滚动谱 |
| `c798` | 吉他之家 798 | `http://www.798com.com/` | 免费论坛六线谱/TXT谱，自动转可滚动谱 |
| `jita17` | 17吉他网 | `https://www.17jita.com/` | 免费 C/G 调新手弹唱与指弹谱，支持多页自动拼接识谱 |
| `ccguitar` | 虫虫吉他 | `https://www.ccguitar.cn/` | 免费民谣吉他六线谱与指弹谱，高清图自动转可滚动谱 |
| `jitashe` | 吉他社 | `https://www.jitashe.org/` | 免费吉他社区曲谱，自动转可滚动谱 |
| `qupu2` | 爱曲谱网 | `https://www.2qupu.com/jita/` | 免费吉他弹唱谱与曲谱大全 |
| `jitaCom` | 吉他网免费区 | `https://www.jita.com/wenku/list/2?feeType=free` | 吉他网免费专区曲谱 |
| `ultimateGuitar` | Ultimate Guitar | `https://www.ultimate-guitar.com/` | 免费英文/国际六线谱与和弦谱 |
| `chordproGithub` | GitHub 开源曲谱库 | `https://github.com/` | 开源 ChordPro / ASCII 六线谱仓库检索 |

## 导入与图片/PDF 转换能力

| 格式 | 处理方式 | 转换结果 |
| --- | --- | --- |
| `.pdf`（扫描版 / 图片型） | `pdfjs` 渲染高清页图 → 全页六线谱 OMR（含和弦指法图 + 符尾节奏识别） | 可滚动、可发声 alphaTex 六线谱 + 原谱页图对照 |
| `.pdf`（内嵌文本层） | 跨页合并文本层六线谱 / ChordPro 解析 | 可滚动、可发声 alphaTex 六线谱 |
| `.jpg / .png / .webp`（单张或多张） | 自动去水印 + 六线谱几何 OMR + 和弦图 `×` 音型还原（多张自动合并） | 可滚动、可发声 alphaTex 六线谱 + 原图对照 |
| `.gp3/.gp4/.gp5/.gpx/.gp7` | alphaTab 原生解析 | 完整多轨六线谱与五线谱 |
| `.musicxml/.xml` | alphaTab 原生解析 | 完整谱面 |
| `.mid/.midi` | `@tonejs/midi` → alphaTex | 自动分配吉他在弦品位与小节 |
| `.txt / .tab / .cho / .crd` | `asciiTab.ts` / `chordpro.ts` | 智能识别和弦与时值，转可滚动谱 |

## 本地开发与打包

```bash
npm install          # 安装依赖并复制字体资源
npm run dev          # 启动本地开发服务 http://127.0.0.1:5173
npm test             # 运行解析器与 OMR 单元测试
npm run build        # 类型检查 + 生产构建
```

推送到 GitHub `main` 分支或打 `v*` 标签后，`.github/workflows/build.yml` 自动构建 Windows 安装包、Android APK（含 `AudioPlaybackCapture` 原生系统内录支持）与 iOS IPA。