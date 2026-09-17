# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本（SemVer）。

## [1.0.5] - 2026-09-17

### 修复

- **P0**：手动放置的 apktool.jar 不被识别，右上角仍显示"待安装"
  - 根因 1：`APKTOOL_MIN_SIZE` 阈值 5MB 过高，用户手动下载的 3.9MB jar 被拒绝
  - 根因 2：`getApktoolJarPath` 只检查 `%APPDATA%` 目录，不检查软件安装目录
  - 根因 3：无 ZIP 签名校验，损坏/截断的 jar 也被接受
  - 修复：
    - `APKTOOL_MIN_SIZE` 从 5MB 降至 1MB
    - 新增 `isValidJar()` 校验 ZIP 签名（`PK\x03\x04`）
    - `getApktoolJarPath` 搜索 3 个位置：`%APPDATA%/tools/`、软件目录`/tools/`、软件目录根目录
    - 下载完成后也校验 ZIP 签名，损坏文件自动清理重试

- **P0**：v1.0.4 的纯 JS 二进制 XML 解析器 UTF-8 解码错误
  - 根因：`parseStringPool` 的 UTF-8 分支用 `String.fromCharCode(buf[pos++])` 逐字节解码，多字节 UTF-8 字符（如中文）会乱码
  - 修复：改用 `buf.toString('utf8', pos, pos + byteCount)` 正确解码

### 改进

- apktool.jar 检测逻辑更健壮：先搜索已存在的 jar（含签名校验），再尝试下载
- 损坏的 jar 文件自动清理后重新下载，不会反复使用无效文件

## [1.0.4] - 2026-09-17

### 修复

- **P0**：apktool.jar 下载失败时，XML 文件完全无法显示 diff 内容
  - 根因：apktool.jar 从 GitHub 下载，但 GitHub 及所有镜像在国内环境下全部不可达，导致降级走 adm-zip → 原始二进制 XML → `isProbablyBinary` 判定为二进制 → 只显示哈希+大小
  - 修复：**新增纯 JS Android 二进制 XML (AXML) 解析器**，不依赖 apktool/Java
    - 新增 `electron/binaryXmlParser.ts`：解析 Android 二进制 XML 格式（字符串池 + 资源映射 + Start Tag chunks）
    - 降级模式下自动检测 AndroidManifest.xml 是否为二进制 XML，若是则用纯 JS 解析器提取权限/元数据/组件
    - Manifest tab 可正常显示权限 diff、元数据 diff、组件 diff
    - Resources tab 点击 AndroidManifest.xml 可显示文本化后的结构化 diff（而非哈希+大小）
    - `isProbablyBinary` 对可解析的二进制 XML 返回 false，标记为文本

### 新增

- `binaryXmlParser.ts`：完整的 Android 二进制 XML 解析器
  - 支持 UTF-8 和 UTF-16LE 字符串池
  - 提取 manifest 属性、uses-sdk、uses-permission、activity/service/receiver/provider、meta-data
  - 自动检测文本/二进制格式，文本 XML 仍走 xmldoc 解析

## [1.0.3] - 2026-09-17

### 修复

- **P0**：关于菜单显示版本号硬编码为 1.0.0，未随 package.json 更新
  - 修复：`electron/main.ts` 动态读取 `package.json` 的 `version` 字段
- **P0**：v1.0.2 的 apktool 下载重试方案未生效，用户仍走降级模式（adm-zip）导致 XML 文件看不到 diff
  - 根因：3 个下载源（github 直连 + ghproxy.com + mirror.ghproxy.com）在用户环境下全部失败
  - 修复：
    - 下载源从 3 个扩展到 7 个（新增 ghproxy.net、gh.llkk.cc、ghfast.top、github.moeyy.xyz）
    - 完整性校验阈值从 1MB 提升到 5MB（apktool.jar 正常约 25MB），过滤不完整/损坏下载
    - 下载进度回调，让用户看到每个源的尝试状态
    - 清理上次下载失败的残留文件后重新下载

### 改进

- **UX**：降级模式下 UI 显示具体原因（如"apktool 下载失败"或"Java 未找到"），而非通用提示
  - 新增 `DiffReport.fallbackReason` 字段
  - SummaryPanel 警告文案改为包含具体原因 + 明确告知 XML 文件无法显示 diff
  - 帮助用户判断是 apktool 问题还是 Java 问题，针对性解决

## [1.0.2] - 2026-09-16

### 修复

- **P0**：降级模式下 XML 文件无法显示 diff 内容——只显示哈希+大小
  - 根因：apktool.jar 下载失败（GitHub 被墙），降级为 adm-zip 直接解压，读到的是 APK 内的原始二进制 XML（Android binary XML format），不是 apktool 反编译后的文本 XML
  - 二进制 XML 包含 null 字节，被 `isProbablyBinary` 识别为二进制，无法显示 diff
- 修复方案：
  - apktool.jar 下载增加重试机制（2 轮 × 3 个下载源 = 6 次尝试）
  - 增加备用下载源：ghproxy.com、mirror.ghproxy.com（绕过 GitHub 被墙）
  - 下载失败时清理不完整的文件，避免残留

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
