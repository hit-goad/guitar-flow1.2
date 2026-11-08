# 上传到 GitHub 并打包（照着点即可）

目标：把源码放进 GitHub，让 GitHub 的免费服务器帮你编译出 **Windows 安装包 / Android APK / iOS IPA**，你不用在本机装 Android SDK、Xcode。

---

## 0. 先解压

把 `GuitarFlow-repo.zip` 解压到一个**路径里没有空格和中文**的位置，例如：

```
D:\code\guitarflow
```

解压后应该能直接看到这些（不是再多套一层文件夹）：

```
.github/   src/   electron/   scripts/   tests/   public/
package.json   README.md   vite.config.ts   ...
```

> 如果你拿到的是 `GuitarFlow-source.zip`（没有 `.git`），也能用，只是第 1 步方式 A 要选「create a repository」。

---

## 1. 放进 GitHub（两种方式，选一个）

### 方式 A：GitHub Desktop（推荐，最省事）

1. 下载安装 [GitHub Desktop](https://desktop.github.com/)（Windows 版）。
2. 打开后 `File → Sign in`，用浏览器里那个 GitHub 账号登录。
3. 菜单 `File → Add local repository…`，选择 `D:\code\guitarflow`。
4. 如果提示 *"This directory does not appear to be a Git repository"*，点下面的 **create a repository**，Name 填 `guitarflow`，点 Create。
5. 右上角点 **Publish repository**：
   - Name：`guitarflow`
   - 想公开就取消勾选 *Keep this code private*
   - 点 **Publish repository**

推上去后，GitHub 会自动开始跑 Windows 和 Android 的打包（见第 2 步）。

### 方式 B：只用浏览器上传

1. 浏览器打开 https://github.com/new
2. Repository name 填 `guitarflow`，**不要**勾 Add a README / .gitignore / license（勾了会冲突），点 **Create repository**。
3. 在新仓库页面点 **uploading an existing file**（或 `Add file → Upload files`）。
4. 打开 `D:\code\guitarflow` 文件夹，`Ctrl+A` 全选里面的**所有内容**（不是选这个文件夹本身），拖进浏览器上传区。
5. 等文件列表加载完，点 **Commit changes**。
6. **关键检查**：回到仓库首页，文件列表里必须能看到 `.github` 这个文件夹；点进去应有 `.github/workflows/build.yml`。
   - 如果看不到 `.github`：点 `Add file → Create new file`，文件名直接输入
     `.github/workflows/build.yml`，然后把本机 `D:\code\guitarflow\.github\workflows\build.yml`
     用记事本打开、全选复制、粘贴进去，Commit。

---

## 2. 让 GitHub 开始打包

推送成功后：

1. 打开仓库页面 → 顶部 **Actions** 标签。
2. 如果第一次进来看到 *"Workflows aren't being run on this repository"*，点 **I understand my workflows, go ahead and enable them**。
3. 左侧点 **打包三端**，能看到一次正在运行的记录（黄色圆点）。
4. 想立刻连 iOS 一起打：点右侧 **Run workflow** → Branch 选 `main` → **Run workflow**。

各平台耗时参考：

| 任务 | 耗时 | 说明 |
| --- | --- | --- |
| Windows 安装包 | 4–8 分钟 | 出 NSIS 安装包 + 便携版 exe |
| Android 安装包 | 6–12 分钟 | 首次要下载 Gradle 依赖 |
| iOS 安装包 | 8–15 分钟 | 只在打标签或手动运行时执行 |

---

## 3. 下载安装包

**方式一：Actions 页面**

点进那次运行 → 页面拉到最下面 **Artifacts** → 下载：

- `guitarflow-windows` → 解压得到 `GuitarFlow Setup 1.0.0.exe` 和 `GuitarFlow 1.0.0.exe`
- `guitarflow-android` → 解压得到 `app-debug.apk`、`app-release.aab`
- `guitarflow-ios` → `GuitarFlow-unsigned.ipa`

**方式二：发一个 Release（更适合发给别人）**

1. 仓库右侧 **Releases** → **Draft a new release**
2. Tag 填 `v1.0.0`，标题填 `GuitarFlow 1.0.0`，点 **Publish release**
3. 这次会自动触发带标签的构建，构建完把 exe / apk / ipa **自动挂到这个 Release 下面**，一个链接就能下载全部。

---

## 4. 装到手机上

- **Android**：把 `app-debug.apk` 传到手机 → 点击安装 → 允许「安装未知来源应用」。首次打开会申请麦克风权限，允许后才能用实时音高检测。
- **iOS**：`GuitarFlow-unsigned.ipa` 是**未签名**的，不能直接装。两条路：
  - 用 [Sideloadly](https://sideloadly.io/) 或 AltStore，用你自己的 Apple ID 自签后安装（免费账号 7 天要重签一次）；
  - 有付费开发者账号（$99/年）的话，把证书 `p12`、描述文件、Team ID 存成仓库 Secrets，就能出正式包并走 TestFlight。

---

## 5. 想发正式签名的 Android 包（可选）

`Settings → Secrets and variables → Actions → New repository secret` 加四个：

| 名称 | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 你的 keystore 文件做 base64（`certutil -encode` 或在线工具） |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 别名 |
| `ANDROID_KEY_PASSWORD` | 别名密码 |

加了之后流水线会自动产出**已签名**的 AAB，可直接传 Google Play 或分发给别人。

---

## 6. 常见问题

| 现象 | 处理 |
| --- | --- |
| Actions 里没有「打包三端」 | 确认 `.github/workflows/build.yml` 已上传；`Settings → Actions → General` 选 Allow all actions |
| `npm ci` 报错找不到 lockfile | `package-lock.json` 没上传，补传一次 |
| Android 构建卡在 Gradle | 第一次正常，等 5–10 分钟；失败就点 **Re-run failed jobs** |
| iOS 卡在 `pod install` | 网络问题，重跑一次即可 |
| 私有仓库提示额度用完 | 公开仓库免费无限，或减少运行次数 |
| 装好后没有声音 | 先点一下页面（浏览器/桌面版）激活音频，再点播放 |

---

## 7. 本机自己打包（不想等 CI）

```bash
npm install
npm test          # 22 项通过再打包，避免白等
npm run build

# Windows 安装包（需要本机能联网下载 Electron）
npm run electron:build          # 产物在 release/

# Android（需要 JDK 17+ 与 Android SDK）
npm run build && npx cap add android && npx cap sync android
cd android && ./gradlew assembleDebug

# iOS（需要 macOS + Xcode + CocoaPods）
npm run build && npx cap add ios && npx cap sync ios
cd ios/App && pod install && open App.xcworkspace
```

国内网络下载 Electron 慢的话，先设镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run electron:build
```