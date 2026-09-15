# APK Diff Tool

一个 **Electron 桌面应用**：上传两个 APK 文件（原版 + 修改版），工具通过 apktool 反编译，直观对比四个维度并生成差异报告：

- ✅ **权限清单**：`uses-permission` 增/删/改（含 `maxSdkVersion`）
- ✅ **AndroidManifest.xml 元信息**：package / versionCode / versionName / minSdk / targetSdk / application 属性
- ✅ **Manifest 组件**：activity / service / receiver / provider 逐字段对比
- ✅ **smali 代码 Diff**：类级 unified diff（支持 `smali_classes2..N`）
- ✅ **资源文件对比**：`res/` + `assets/` 文本走 unified diff，二进制走哈希 + 大小对比

**明确排除**：签名对比（`META-INF/`）。

---

## 前置要求

- **Node.js ≥ 20**
- **Java ≥ 11**（可选，缺失时应用会自动下载便携版 Azul Zulu JDK 17）
- **Windows 10+** / macOS / Linux

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 开发模式启动（Vite HMR + Electron）
npm run dev

# 3. 打包为 Windows 可执行文件
npm run dist
```

打包产物位于 `release/` 目录，双击 `.exe` 安装即可。

---

## 核心脚本

| 脚本 | 说明 |
| --- | --- |
| `npm run build` | 编译主进程（tsc）+ 渲染层（vite） |
| `npm run build:main` | 仅编译 Electron 主进程 |
| `npm run build:renderer` | 仅构建前端 |
| `npm run dev` | 开发模式，HMR |
| `npm run dist` | 打包为 Windows NSIS 安装包 |
| `npm run dist:dir` | 打包为未压缩目录（调试用） |

---

## apktool 自动检测机制

应用**不自己实现反编译**，而是通过调用 apktool jar 完成。首次启动时会自动：

1. **Java 检测顺序**：
   - `JAVA_HOME` 环境变量
   - `PATH` 中的 `java`
   - 常见安装目录（Eclipse Adoptium / Zulu / Java JDK17）
   - 如果系统没有 Java → **自动下载 Azul Zulu JDK 17 便携版**到 `userData/tools/zulu-jdk17/`

2. **apktool 下载**：
   - 从 `https://github.com/iBotPeaches/Apktool/releases/download/v2.9.3/apktool_2.9.3.jar` 下载到 `userData/tools/apktool_2.9.3.jar`
   - 版本号固定，幂等下载

3. **反编译调用**：
   ```
   java -jar apktool_2.9.3.jar d -f -o <out_dir> <apk>
   ```

4. **双路降级**：如果 Java + apktool 都不可用，退化为纯 `adm-zip` 解压 zip 模式，仅对比 `res/` + `assets/` + `AndroidManifest.xml`（未反编译），smali 部分标记为不可用，UI 顶部会显示"zip 降级模式"提示。

---

## 文件结构

```
apk-diff-tool/
├── electron/
│   ├── main.ts           # 窗口、菜单、单实例锁、ipcMain 注册
│   ├── preload.ts        # contextBridge 白名单 API
│   ├── apk-worker.ts     # Java/apktool 检测+下载+反编译+zip 降级
│   ├── diff-engine.ts    # 四路 diff 引擎（权限/Manifest/smali/res）
│   └── ipc-handlers.ts   # IPC 通道注册
├── src/
│   ├── main.tsx          # React 入口
│   ├── App.tsx           # 顶部工具栏 + 四 tab 布局
│   ├── theme.ts          # MUI 主题
│   ├── index.css         # Tailwind + diff 行样式
│   ├── types.ts          # window.apkDiff 类型声明
│   └── components/
│       ├── UploadPanel.tsx
│       ├── SummaryPanel.tsx
│       ├── PermissionsView.tsx
│       ├── ManifestView.tsx
│       ├── SmaliDiffView.tsx
│       └── ResourcesView.tsx
├── shared/
│   └── types.ts          # 主进程/渲染层共享的 DiffReport 等类型
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── electron-builder.yml
├── tailwind.config.ts
├── postcss.config.js
├── index.html
└── .gitignore
```

---

## 已知限制

- **两个 APK 串行反编译**：避免两个 JVM 同时运行抢爆内存。大 APK（>200MB）反编译可能需要 30-60 秒。
- **懒加载 diff**：类/资源的统一 diff 通过 `getClassDiff`/`getResourceDiff` IPC 按需拉取，避免首次对比把所有 diff 塞进 IPC 通道。
- **多 dex 支持**：`smali_classes2`、`smali_classes3` 等目录自动扫描。
- **超大 APK**：>1 万类时前端列表可能卡顿，已用懒加载 IPC 缓解但仍有优化空间。
- **Java 检测失败降级**：无网络时无法下载便携 JDK，会退化到 zip 解压模式（无 smali）。
- **拖拽 APK 路径限制**：Electron 31 + contextIsolation 下 `File.path` 已废弃，拖拽上传只能拿到文件名。请优先使用"选择文件"按钮；拖拽仅作为视觉提示（若必须用拖拽，可在后续版本通过 `webUtils.getPathForFile` 补上）。

---

## 使用流程

1. 启动应用
2. 拖拽两个 APK 到左侧上传区（或点击"选择文件"）
3. 点击"开始对比"
4. 顶部概览卡片展示变更总数（可点击跳对应 tab）
5. 切换四个 tab 查看：
   - **权限**：表格 + 状态过滤（新增/删除/修改）
   - **Manifest**：元信息表 + 组件 Accordion
   - **smali**：左侧类列表 + 右侧 unified diff
   - **资源**：左侧文件列表 + 右侧 diff 或哈希对比

---

## 项目笔记

- **共享类型**：`shared/types.ts` 定义 `DiffReport`、`PermissionRow`、`ManifestDiffResult`、`ClassDiffEntry`、`ResourceFileDiff`、`DiffSummary`、`Decompprogress`、`ApkDiffApi` 和 `IPC` 常量。主进程和渲染层都从这一处 import，保证 IPC 契约一致。
- **IPC 通道字符串**：`apk-diff:open-apk-picker` / `apk-diff:start-diff` / `apk-diff:get-class-diff` / `apk-diff:get-resource-diff` / `apk-diff:get-apktool-info` / `apk-diff:on-progress`。preload、ipc-handlers、shared/types 三处必须完全一致。
- **签名排除**：`diff-engine.ts` 完全不扫描 `META-INF/`，符合需求。
