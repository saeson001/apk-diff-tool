# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本（SemVer）。

## [1.0.1] - 2026-09-16

### 修复

- **P0**：smali / res diff 内容不可见——点击文件名后右侧区域空白。根因：
  - `maxHeight: calc(100vh - 360px)` 硬编码，但顶部组件（AppBar + UploadPanel + SummaryPanel + Tabs）实际总高度约 480px，diff 区域被压缩到几乎不可见
  - CSS `.diff-line` 的 `padding: 0 12px` 和 `overflow-x: auto` 与 JSX flex 布局冲突，padding 挤占 flex 子项空间
  - Paper 缺少 `overflow: 'hidden'`，子元素溢出但不可见
- 修复方案：
  - 改用 `flex: 1, height: 0` 让 diff 区域自适应父容器剩余空间，替代硬编码 maxHeight
  - Paper 添加 `overflow: 'hidden'`，内层 Box 添加 `display: 'flex', flexDirection: 'column'`
  - CSS `.diff-line` 移除 `padding` 和 `overflow-x`（改由 JSX 的 pl/pr 控制）
  - 添加 `alignItems: 'baseline'` 让行号与文本基线对齐

## [1.0.0] - 2026-09-15

首个公开版本。

### 新增

- Electron 31 + React 18 + TypeScript + Vite 5 + MUI 5 桌面应用骨架
- 上传两个 APK 后自动调用 apktool 2.9.3 反编译（缺失时自动下载便携版 Azul Zulu JDK 17）
- 四个维度的差异对比：
  - 权限清单：`uses-permission` 增/删/改，含 `maxSdkVersion`
  - AndroidManifest.xml 元信息：package / versionCode / versionName / minSdk / targetSdk / application 属性
  - Manifest 组件：activity / service / receiver / provider 逐字段对比（exported / enabled / permission）
  - smali 代码 + 资源文件：unified diff（`@@ -L,N +L,N @@` 头），带行号列
- 双路降级：Java + apktool 不可用时用 `adm-zip` 解压，smali 标记不可用
- 行号定位：Manifest 元信息 / 组件、权限列表、smali/res diff 均标注原版行号与修改版行号

### 修复

- **P0**：`downloadFile` 中 `file.close()` 异步未 await 导致 Windows EPERM rename，改为 `file.end(callback)` 在关闭回调内 rename
- **P0**：`decompileApk` 返回的 outDir 被 IPC 层忽略，diff 全空；改用真实反编译输出目录
- **P0**：sessionId 未回传渲染层，懒加载 diff 永远猜不到
- **P1**：`makeUnifiedDiff` 用 `structuredPatch` 手造伪 unified diff，改为 `diffLines` 输出标准格式
- **P2**：清理多处死代码与占位符

### 遗留

- 拖拽 APK 在 Electron 31 + contextIsolation 下 `File.path` 已废弃，需 `webUtils.getPathForFile`；当前通过文件选择器回退路径可用，见 README Known Issues

---

## 版本演进约定

- **每改一版必升版本号**（SemVer）：修复 Bug 升 patch（1.0.0 → 1.0.1），新增特性升 minor（1.0.0 → 1.1.0），破坏性变更升 major
- **打包产物不进 git**（`.gitignore` 排除 `release/`），通过 GitHub Release 分发
- **每个版本对应一个 GitHub Release**（tag 形如 `v1.0.0`），Release Notes 写本文件对应章节的内容
- 打包命令：`npm run dist`（输出到 `release/`）；若 `app.asar` 被占用，改用 `npx electron-builder --win --config.directories.output="release-bak"` 输出到备用目录
