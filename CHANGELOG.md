# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本（SemVer）。

## [1.3.10] - 2026-09-24

### 修复

- **修复 v1.3.9 双击 exe 完全无反应（无法启动）**：根因是 `node_modules/electron` 的 npm 占位 stub 被打进 app.asar，运行时主进程 `require('electron')` 优先命中 stub 返回字符串而非运行时模块，`app` 未定义导致进程静默退出。本版在 `electron-builder.yml` 的 `files` 中显式排除 `node_modules/electron/**`，确保 asar 内不再包含 stub
- **新增主进程启动期 FATAL 自检**：`electron/main.ts` 启动时校验 `app` 模块可用性，若 `require('electron')` 返回异常内容则输出 `[FATAL]` 日志并退出码 1，便于用户日志定位，不再静默崩溃
- **兜底版本号更新**：`FALLBACK_VERSION` 从 1.3.9 更新为 1.3.10

## [1.3.9] - 2026-09-24

### 修复

- **修复 v1.3.8 发布包构建错误**：v1.3.8 的 `dist-electron/electron/main.js` 未包含版本检测逻辑（构建时漏编译 electron 主进程），导致所有用户看到 `version=unknown` 且无 `[version-check]` 日志。本版正确编译了 electron 主进程，版本检测系统完整可用
- **兜底版本号更新**：`FALLBACK_VERSION` 从 1.3.8 更新为 1.3.9

## [1.3.8] - 2026-09-21

### 新增

- **底层版本校验系统**：启动时依次尝试 5 种版本检测方法（app.getVersion() → asar package.json → exe 旁 package.json → 版本缓存 → 硬编码兜底），记录每种方法的尝试结果（成功/失败/错误原因），日志里能看到每个方法返回了什么
- **版本检测失败弹窗告警**：如果所有检测方法都失败（使用兜底版本），启动时自动弹窗提示"版本检测失败，请删除目录后重新解压"
- **版本检测结果写入缓存**：成功检测的版本写入 `%APPDATA%/APK Diff Tool/app-version.json`，下次启动优先读缓存，即使 app.asar 损坏也能显示上次检测到的版本
- **底部状态栏**：UI 底部新增状态栏，显示版本号 + 版本检测时间 + 成功方法数，一眼确认运行版本
- **About 对话框显示版本检测详情**：菜单 → 关于，显示每个检测方法的尝试结果，新增"重新检测"按钮

### 修复

- **版本号显示 unknown 问题**：旧版本所有检测手段失败时返回 'unknown'，用户无法判断是否更新成功；v1.3.8 改用 5 层检测 + 兜底版本号，日志里能看到每个方法的具体结果

### 诊断方式

启动日志里现在能看到版本检测详情：
```
[version-check] OK: app.getVersion() → 1.3.8 (Electron API)
[version-check] FAIL: asar:package.json (...): no version field
[version-check] FAIL: exe-dir:package.json (...): ENOENT
```
如果看到 `ALL methods failed`，说明 app.asar 里的 package.json 有问题，需要删除目录重新解压。

## [1.3.7] - 2026-09-21

### 修复

- **渲染进程加载失败时显示降级 UI**：当 preload 脚本加载失败（`window.apkDiff` 不存在）时，显示错误提示和修复步骤，不再显示空白窗口
- **新增渲染进程错误日志**：`did-fail-load` + `console-message` 事件转发到主进程日志，下次 UI 异常时日志能定位根因

### 操作提示

如果之前解压后界面空白：
1. **完全删除** `D:\test\apkdiff\` 目录（先关闭所有旧进程）
2. 重新解压 `apk-diff-tool-1.3.7-portable.zip` 到 `D:\test\apkdiff\`
3. 启动后看 UI 右上角版本号徽标（应显示 `v1.3.7`）

## [1.3.6] - 2026-09-21

### 新增

- **UI 右上角显示软件版本号**：标题栏右侧显示 `v1.3.6` 蓝色徽标，一眼确认运行版本
- **新增 IPC 通道 `GET_APP_VERSION`**：渲染进程通过 `window.apkDiff.getAppVersion()` 获取版本号

### 修复

- **版本号检测增强诊断日志**：记录 `app.getVersion()` 原始返回值 + `app.getAppPath()` + `app.isPackaged`，下次日志能立即定位版本检测失败原因
- **硬编码兜底版本号**：所有动态检测手段都失败时返回 `FALLBACK_VERSION`（当前 1.3.6），不再返回 `unknown`
- **版本检测顺序优化**：`app.getVersion()` → asar 内 package.json → asar 旁 package.json → 硬编码兜底

## [1.3.5] - 2026-09-21

### 修复

- **关于页版本号显示 unknown**：
  - 根因：`getAppVersion()` 用 `fs.readFileSync` 读 asar 旁边的 `package.json`，但 electron-builder 把 `package.json` 打包进 `app.asar` 内部，旁边不存在该文件 → 返回 `'unknown'`
  - 修复：改用 Electron 内置 `app.getVersion()`（能正确从 asar 内读取），保留手动读 package.json 作为开发模式兜底
  - `logger.collectDebugInfo()` 同步修复，诊断面板也能正确显示版本号
  - 启动日志现在会显示真实版本号，便于确认实际运行版本

### 提示

- 如果之前看到"关于"页显示 `unknown`，说明实际运行的可能是旧版本（关于页版本显示 bug 导致误判）
- 请核对启动日志第一行的 `version=xxx` 确认实际运行的版本号
- JVM 参数（runApktool 日志行）也能区分版本：v1.3.3+ 应该是 `-Xmx768m -XX:MaxDirectMemorySize=384m -XX:MaxMetaspaceSize=256m`

## [1.3.4] - 2026-09-21

### 修复

- **AI API 返回空/截断 JSON 导致推荐不可用**：
  - 症状：AI API 返回 HTTP 200 但 body 为空或 JSON 被截断（缺少闭合 `}`），日志显示 `Unexpected end of JSON input` / `Unterminated string in JSON`
  - 修复：空响应自动重试一次（max_tokens 从 300 提升到 500）；截断 JSON 自动补 `}` 后尝试解析；解析失败时 fallback 到 `full_apktool`
  - 系统 prompt 增加"确保 JSON 完整（以 } 结尾）"指令，降低截断概率

## [1.3.3] - 2026-09-20

### 修复

- **修复 v1.3.2 诊断代码自身导致崩溃的严重回归**：
  - 根因：heartbeat 用 `spawnSync('tasklist')` 同步查询 Java 进程内存 → **阻塞 Electron 事件循环**
  - 在系统内存压力大时 `tasklist.exe` 启动极慢 → 事件循环阻塞 2 分钟 → Node.js GC 无法运行 → Electron 进程内存膨胀 → OS 杀进程
  - 修复：改用异步 `execFile`（不阻塞事件循环）

- **修复 javaMem 监控数据错误**：
  - 根因：正则 `/"java\.exe","(\d+)"/` 匹配的是 PID 字段而非内存字段，把 PID 除以 1024 当成了 MB（显示 5MB/13MB 的假数据）
  - 修复：改正则为匹配末尾的 `"数字 K"` 字段（tasklist CSV 最后一列是内存，单位 KB）

### 优化

- **JVM 内存参数调优**（总上限从 ~1.5GB 降到 ~1.5GB，更均衡）：
  - `-Xmx1024m` → `-Xmx768m`（为系统留出更多余量）
  - `-XX:MaxDirectMemorySize=512m` → `=384m`
  - 新增 `-XX:MaxMetaspaceSize=256m`（限制类元数据内存）
  - 内存警告阈值从 2GB 降到 1.8GB

## [1.3.2] - 2026-09-20

### 修复

- **修复连续反编译两个大 APK 时 Electron 主进程被 OS OOM Killer 静默杀死**：
  - 根因：`-Xmx1024m` 只限制 JVM 堆内存，**DirectByteBuffer（堆外内存）不受限制**，默认上限等于 `-Xmx`
  - apktool 在 "Copying original files" 阶段用 Java NIO 大量拷贝 `classes*.dex`，会分配大量 DirectByteBuffer → 吃光系统物理内存 → OS 杀掉 Electron 主进程（不是 Java 进程，所以 v1.2.1 的 uncaughtException 处理器不会触发）
  - 修复：新增 `-XX:MaxDirectMemorySize=512m` 硬限制堆外内存，总 JVM 内存上限从 ~2GB 降到 ~1.5GB

### 新增

- **JVM OOM 干净退出**：新增 `-XX:+ExitOnOutOfMemoryError`，JVM 自身 OOM 时干净退出（能拿到 exit code），不再静默挂死
- **Java 进程内存监控**：heartbeat 每 30s 用 `tasklist` 查询 java.exe 工作集内存并写入日志，超过 2GB 触发 ERROR 警告
- **卡死检测**：120 秒无任何 Java 输出时记录 `apktool STUCK` ERROR 日志，便于定位 hang 死问题
- **新增进度阶段**：识别 "Copying assets and libs" (90%) / "Copying original files" (92%) 阶段
- **JVM OOM 错误识别**：close 处理器检测 stderr 中的 `OutOfMemoryError` / `heap space` / `Direct buffer memory`，给出专门的错误信息

## [1.3.1] - 2026-09-20

### 修复

- **修复 AI API URL 404 问题**：API Base URL 字段现在兼容两种格式
  - Base URL：`https://api.deepseek.com/v1`（自动拼接 `/chat/completions`）
  - 完整端点：`https://token.sensenova.cn/v1/chat/completions`（直接使用，不再重复拼接）
  - 之前仅支持 Base URL 格式，填入完整端点会导致 `.../chat/completions/chat/completions` → 404

## [1.3.0] - 2026-09-19

### 新增

- **AI API 集成**：选择 APK 后自动调用 AI 分析文件元数据，推荐最合适的分析方案
  - 支持任何 OpenAI Chat Completions 兼容 API（DeepSeek / OpenAI / 通义千问 / 智谱等）
  - AI 分析两个 APK 的大小、文件数、结构相似度，推荐 `full_apktool`（完整反编译）或 `hash_only`（快速哈希比对）
  - AI 配置界面：工具栏 AI 图标 → 对话框，配置 Base URL / API Key / 模型名，支持测试连接
  - 配置保存在 `settings.json`，未配置时默认使用完整反编译模式

- **快速哈希比对模式（hash_only）**：
  - 无需 apktool/Java，直接读取 APK 的 ZIP 条目元数据
  - 比较文件大小（不同=修改，相同=未变），跳过哈希计算，秒级完成
  - 按文件类型分类：DEX / XML / 图片 / 资源 / 资源文件 / 原生库 / 其他
  - 按变更状态排序：修改 > 新增 > 删除 > 未变
  - 支持展开/收起分类，可切换显示全部或仅变更文件

### 改进

- 工具栏新增 AI 图标（已配置时绿色高亮）
- 选择 APK 后自动采集元数据（文件大小、文件数、ZIP 条目列表、结构相似度）

## [1.2.1] - 2026-09-18

### 修复

- **修复连续反编译两个 APK 时第二个 APK 卡死/崩溃**：
  - 根因：第一个大 APK 的 apktool JVM 无 `-Xmx` 限制，消耗大量内存；第二个 APK 的 `ensureApktool` 用 `spawnSync` 重新启动 JVM 时系统 OOM，导致 Electron 主进程挂死或崩溃
  - 修复：缓存 `ensureApktool` 结果，第二个 APK 直接复用检测结果，跳过重复的 JVM 启动
  - `runApktool` 增加 `-Xmx1024m` JVM 堆内存限制，防止大 APK 反编译时 OOM
  - `getApktoolVersion` 增加 `-Xmx256m`，限制版本检查的内存占用
- **`runApktool` 增加 30 分钟超时保护**：超时后自动终止 apktool 进程并报错，防止永久挂死
- **`runApktool` 增加 30 秒心跳日志**：记录 elapsed 秒数 + 当前阶段 + 进度百分比，解决"卡在 88% 不知道在干什么"问题
- **apktool stdout/stderr 实时写入日志**：之前 stderr 仅在失败时才记录，现在每行实时写入，便于排查 apktool 内部错误

### 改进

- **日志系统增强**：WARN 级别日志也立即 flush（之前仅 ERROR），防止崩溃时缓冲日志丢失
- **进程退出时强制 flush 日志**：`process.on('exit')` 和 `process.on('uncaughtException')` 时调用 `logger.flush()`
- **全局异常捕获**：`main.ts` 增加 `uncaughtException` 和 `unhandledRejection` 处理器，记录崩溃原因后 flush 日志

### 已知限制

- apktool 反编译大 APK 仍需 10-15 分钟，这是 apktool 本身的性能限制，无法通过代码优化解决

### 新增

- **内置 JRE + apktool.jar**：便携版包内置完整 JRE（Zulu 17.0.20.1，约 45MB）和 apktool.jar（2.9.3，约 22MB）
  - 无需下载、无需安装 Java，解压即用
  - 彻底消除 Azul CDN / GitHub 被墙导致的无法反编译问题
  - 搜索优先级：内置 JRE → 用户配置路径 → JAVA_HOME → PATH → 常见目录 → 自动下载
  - 包体增大：约 119MB → 约 215MB

### 改进

- `downloadFile` 增加 30 秒超时（防止连接挂起）
- `downloadFile` 增加 User-Agent 头（部分 CDN 拒绝无 UA 请求）
- `downloadFile` 增加下载字节数日志
- 诊断面板新增 `bundledJavaCmd` / `bundledJarPath` 字段

## [1.1.1] - 2026-09-18

### 修复

- **Java 便携版下载 URL 失效**：原 URL `zulu17.54.0.11-ca-jdk17.0.13-win_x64.zip` 已被 Azul 下线（HTTP 404），导致无 Java 环境下无法自动下载 JDK，apktool 永远显示"待安装"
  - 更新为有效版本：`zulu17.68.203-ca-jre17.0.20.1-win_x64.zip`（JRE 比 JDK 小很多，约 45MB）
  - 增加多版本兜底：17.68.203 / 17.66.19 / 17.64.17
  - 平台覆盖：Windows x64 / macOS aarch64 / Linux x64

- **状态显示误导**：jar 已找到但 Java 缺失时，UI 显示"apktool 待安装"（实际 jar 已就绪，只是无法运行）
  - 修复：区分三种状态——"apktool 待安装"（jar 未找到）/"apktool jar 已就绪 · Java 未就绪"（jar 有但无 Java）/"apktool X.X.X · Java Y"（全部就绪）

### 新增

- **手动配置 Java 路径**：工具栏齿轮图标 → Java 路径配置对话框
  - 支持浏览选择 java.exe 或手动输入路径
  - 配置后立即重新检测，实时显示 Java 版本状态
  - 路径保存在 `%APPDATA%/APK Diff Tool/settings.json`
  - `findSystemJava` 优先检查用户配置路径（最高优先级，在 JAVA_HOME 之前）

- **诊断面板增强**：新增 `configuredJavaPath` 字段，显示当前配置的 Java 路径

### 已知问题

- 若 Azul CDN 也被网络屏蔽（国内部分环境），自动下载仍可能失败。此时请使用手动配置 Java 路径功能
- 降级模式（无 Java）下 res/*.xml 等资源文件仍显示为二进制哈希（仅有 AndroidManifest.xml 支持纯 JS AXML 解析）

## [1.1.0] - 2026-09-18

### 新增

- **诊断信息面板**：工具栏新增"诊断"按钮，展示完整的路径、jar 搜索记录、Java 搜索记录
  - 显示 exePath、appPath、userData、logFile 等关键路径
  - 展示每个 jar 搜索候选路径的存在性、文件大小、ZIP 有效性
  - 展示每个 Java 检测候选的路径和发现状态
  - 状态概览：apktool jar 是否找到、Java 版本、打包模式

- **日志系统**：新增 `electron/logger.ts`，所有关键操作写入日志文件
  - 日志位置：`%APPDATA%/APK Diff Tool/logs/app-YYYY-MM-DD.log`
  - 记录内容：jar 搜索路径/结果、Java 检测过程、下载尝试、反编译进度
  - 同时输出到 console（开发调试）

- **日志导出**：支持导出日志到用户指定位置
  - 菜单"工具 → 导出日志…"
  - 诊断面板内"导出日志"按钮
  - 日志目录：`%APPDATA%/APK Diff Tool/logs/`，菜单"工具 → 打开日志目录"

- **菜单增强**：新增"工具"菜单，包含诊断信息、打开日志目录、导出日志

### 改进

- `apk-worker.ts` 全量日志化：所有路径搜索、文件校验、下载操作都有详细日志
- `getApktoolJarPath` 搜索路径记录到 `state.jarSearchLog`，供诊断面板展示
- `findSystemJava` 搜索结果记录到 `state.javaSearchLog`，供诊断面板展示
- 新增 `getDebugData()` 导出诊断数据

## [1.0.6] - 2026-09-17

### 修复

- **P0**：v1.0.5 的 `isValidJar` 仅检查 ZIP 魔数（`PK\x03\x04`），截断/损坏的 jar 会误判为有效
  - 修复：`isValidJar` 改用 adm-zip 实际打开 ZIP 并读取条目列表，截断/损坏文件会抛异常被正确拒绝
  - 效果：损坏 jar 不再被误用，程序立即降级到纯 JS 二进制 XML 解析器，右上角状态清晰

### 改进

- `isValidJar` 双阶校验：先检查 PK 魔数（快速失败），再用 adm-zip 验证 ZIP 完整性（捕获截断）

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
