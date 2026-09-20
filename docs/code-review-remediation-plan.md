# YoonCode 代码审查整改规划

> 仓库：`lanjunyao/yooncode`  
> 分支：`main`  
> 规划类型：代码安全、架构治理与工程化整改  
> 形成依据：2026-09-20 静态代码审查

## 一、规划背景

当前 YoonCode 已经从单一桌面工具逐步发展为包含 Codex 会话读取、Token 统计、截图管理、OCR、续聊包、故障胶囊、允码伴侣、角色系统、工作来信、系统监控等能力的 Electron 桌面应用。

现阶段核心功能已经具备，但主进程与渲染进程代码逐渐集中，且部分 IPC 文件操作接口的安全边界不够统一。随着后续继续扩展“AI 协作记忆、多 AI 协作、上下文治理、工作流辅助”等能力，如果不提前完成安全与工程化治理，后续维护成本、回归风险和多人协作成本会快速上升。

本规划的目标不是大规模重写，而是在不影响现有业务功能的前提下，分阶段完成安全加固、代码拆分、测试体系和 CI 基础建设。

---

## 二、总体目标

1. 统一 Electron IPC 文件访问安全边界。
2. 封堵路径穿越、软链接绕过等潜在本地文件访问风险。
3. 将 `main.js` 和 `renderer.js` 从“巨型文件”逐步拆分为职责清晰的模块。
4. 建立最基础的自动化测试体系。
5. 建立 GitHub Actions CI，保证多人 / 多 AI 协作下的代码质量。
6. 逐步增强类型约束，降低运行时错误。
7. 全过程保持现有功能行为基本不变，优先采用小步提交和可回滚改造。

---

## 三、当前问题概述

### 3.1 Electron IPC 路径校验不统一

当前截图相关接口中，部分高风险操作已经做了路径限制，例如：

- 删除截图
- 保存标注截图

但以下接口仍直接使用渲染进程传入的路径：

- 打开截图
- 复制截图
- 另存为截图
- 部分截图元数据操作

这会造成同一业务域内安全策略不一致。

### 3.2 Codex Session 目录校验仍基于字符串路径

续聊包生成逻辑已经限制 Session 必须位于：

- `~/.codex/sessions`
- `~/.codex/archived_sessions`

但当前主要依赖 `path.resolve` + `startsWith` 判断。若目录中存在软链接或符号链接，理论上可能出现真实文件位于允许目录之外、但逻辑路径仍通过校验的情况。

### 3.3 主进程职责过度集中

当前 `src/main.js` 同时负责：

- Electron 窗口管理
- Codex Session 扫描
- Token 统计
- SQLite 初始化与持久化
- 截图
- OCR
- 续聊包
- 故障胶囊
- 角色系统
- 工作来信
- 系统监控
- IPC 注册

随着功能增加，修改任意功能都更容易影响其他模块。

### 3.4 Renderer 逻辑过度集中

`src/renderer.js` 同时承载：

- 总览
- 截图库
- 标注
- 续聊包
- 故障胶囊
- 允码伴侣
- 角色
- 设置
- UI 状态
- 事件绑定

页面行为与业务逻辑耦合较重。

### 3.5 缺少自动化测试

当前未形成针对以下关键逻辑的稳定测试：

- 路径白名单
- Session 解析
- Token 统计
- Handoff 数据提取
- Role sanitize
- OCR 分类

### 3.6 缺少 CI

当前仓库未建立持续集成流程，多人或多 AI 修改代码后，缺少统一的自动化验证入口。

---

## 四、实施原则

1. **安全优先**：先修补文件与路径边界，再做架构拆分。
2. **不大规模重写**：优先抽函数、抽模块、保持原逻辑。
3. **一次只做一类改动**：避免安全改造、重构、UI 调整混在同一个提交。
4. **先测试后深拆**：重构前先给关键纯函数补测试。
5. **可回滚**：每个阶段保持独立提交。
6. **不改变现有用户交互**：除非为安全限制所必须。
7. **多 AI 友好**：模块边界、文件职责、测试入口尽量明确，便于 Codex / Claude Code / Cursor 分工。

---

# 五、任务分级

## P0：必须优先处理

### P0-01 统一截图 IPC 路径安全校验

#### 目标

所有截图相关文件操作必须经过统一白名单校验，只允许操作 YoonCode 截图目录内的文件。

#### 建议实现

新增统一工具函数，例如：

```js
function assertScreenshotPath(input) {
  const root = path.resolve(screenshotsDir());
  const resolved = path.resolve(input);

  if (!resolved.startsWith(root + path.sep)) {
    throw new Error('截图路径无效');
  }

  return resolved;
}
```

后续进一步升级为基于 `realpath` 的最终路径判断。

#### 涉及接口

至少统一覆盖：

- `screenshots:open`
- `screenshots:copy`
- `screenshots:save-as`
- `screenshots:save-annotation`
- `screenshots:delete`
- `screenshots:favorite`
- `screenshots:tags`

如其他截图接口接收路径参数，也必须纳入。

#### 验收标准

- 合法截图文件可正常打开、复制、另存、标注、删除。
- 截图目录外文件路径全部拒绝。
- `..` 路径无法绕过。
- 不因安全校验破坏现有截图列表功能。
- 路径校验函数有单元测试。

---

## P1：高优先级

### P1-01 Codex Session 路径改为 realpath 校验

#### 目标

避免基于符号链接的路径逃逸。

#### 建议实现

对：

- 请求的 Session 文件
- `sessionsRoot`
- `archived_sessions`

分别调用：

```js
await fsp.realpath(...)
```

最终判断真实文件路径是否位于真实允许目录中。

#### 验收标准

- 正常 Session 可继续读取。
- Archive Session 可正常读取。
- 允许目录外路径被拒绝。
- 通过 symlink 指向目录外文件时被拒绝。
- Windows 环境行为正常。

---

### P1-02 拆分主进程 main.js

#### 目标

降低主进程单文件复杂度。

#### 建议目录

```text
src/
  main/
    index.js
    windows.js
    ipc.js

    codex/
      sessions.js
      tokens.js
      handoff.js
      replay.js

    screenshots/
      capture.js
      storage.js
      ocr.js
      security.js

    companion/
      roles.js
      letters.js
      dashboard.js

    system/
      stats.js

    db/
      index.js
```

#### 第一阶段建议只拆

1. screenshot
2. codex session
3. database

优先抽离纯逻辑和低耦合模块。

#### 不建议

- 一次性完全重写 `main.js`
- 同时调整 UI
- 同时修改数据库结构
- 同时更换技术框架

#### 验收标准

- `main.js` 只保留应用启动、模块初始化和高层编排。
- 各业务模块不依赖 Renderer DOM。
- 原有功能行为不变。
- 应用正常启动与退出。
- 截图、OCR、Codex Session、续聊包功能正常。

---

### P1-03 拆分 renderer.js

#### 建议目录

```text
src/
  renderer/
    app.js
    overview.js
    screenshots.js
    annotation.js
    companion.js
    memory.js
    replay.js
    settings.js
    utils.js
```

#### 拆分顺序

1. annotation
2. screenshots
3. settings
4. companion
5. memory / handoff
6. overview

#### 验收标准

- 每个模块职责清晰。
- 页面初始化入口唯一。
- 避免跨模块直接读写大量全局变量。
- 原有 UI 和事件行为不变。
- ESC、弹窗、截图标注、角色操作等交互无回归。

---

### P1-04 建立基础自动化测试

#### 推荐方案

优先采用 Vitest。

原因：

- 配置轻量
- 对纯 JS 逻辑友好
- 适合快速补测试
- 后续迁移 TypeScript 也方便

#### 第一批测试

```text
tests/
  path-security.test.js
  session-parser.test.js
  token-usage.test.js
  handoff.test.js
  role-sanitize.test.js
  ocr-category.test.js
```

#### 重点测试

##### 路径安全

- 正常子路径
- `..`
- 相似前缀目录
- 符号链接
- 空字符串
- 非法输入

##### Session

- 正常 JSONL
- 损坏 JSON 行
- 无 token_count
- 无 session_meta
- archive session

##### Token

- 空样本
- 多轮累计
- 上下文百分比
- 超阈值提醒

#### 验收标准

新增：

```json
"test": "vitest run"
```

并确保测试可以在无 Electron GUI 环境运行。

---

## P2：工程化改进

### P2-01 增加 GitHub Actions CI

建议文件：

```text
.github/workflows/ci.yml
```

第一阶段执行：

```text
pnpm install --frozen-lockfile
pnpm test
pnpm lint
```

如果暂时没有 lint，可先执行：

```text
pnpm install --frozen-lockfile
pnpm test
```

后续逐步增加：

- 代码格式检查
- 构建检查
- Electron 打包 smoke test

#### 验收标准

- Push / PR 自动触发。
- 测试失败时 CI 红灯。
- lockfile 不一致时失败。
- main 分支始终可看到最新 CI 结果。

---

### P2-02 引入 ESLint

建议先采用较宽松规则，避免一次产生大量历史问题。

目标不是追求“零 warning”，而是优先防止：

- 未定义变量
- 重复声明
- 明显不可达代码
- Promise 误用
- 高风险隐式全局变量

---

### P2-03 增加类型约束

不建议立即全量 TypeScript 重写。

推荐路线：

#### 阶段一

使用 JSDoc：

```js
/**
 * @param {string} sessionFile
 * @returns {Promise<HandoffPackage>}
 */
```

#### 阶段二

关键数据结构增加 typedef：

- SessionCard
- UsageData
- ScreenshotItem
- CompanionRole
- HandoffPackage
- BugCapsule

#### 阶段三

新模块优先 TypeScript。

#### 阶段四

根据维护收益决定是否迁移旧代码。

---

# 六、建议新增的安全工具层

建议建立：

```text
src/main/security/
  paths.js
```

统一提供：

```text
assertScreenshotPath()
assertCodexSessionPath()
assertWorkspacePath()
assertRoleFilePath()
```

避免各 IPC Handler 自己实现安全判断。

原则：

> 业务 Handler 不直接信任 Renderer 传入的文件路径。

---

# 七、建议的最终目录结构

```text
src/
  main/
    index.js
    windows.js
    ipc.js

    security/
      paths.js

    codex/
      sessions.js
      tokens.js
      handoff.js
      replay.js

    screenshots/
      capture.js
      storage.js
      ocr.js

    companion/
      roles.js
      letters.js
      dashboard.js

    system/
      stats.js

    db/
      index.js

  renderer/
    app.js
    overview.js
    screenshots.js
    annotation.js
    companion.js
    memory.js
    replay.js
    settings.js
    utils.js

  assets/

  index.html
  styles.css
  preload.js
  selector-preload.js
  selector.html
  ocr.ps1

tests/
  path-security.test.js
  session-parser.test.js
  token-usage.test.js
  handoff.test.js
  role-sanitize.test.js
  ocr-category.test.js

.github/
  workflows/
    ci.yml
```

该目录为目标结构，不要求一次完成。

---

# 八、实施顺序

## 阶段 A：安全修复

1. 抽取路径安全工具。
2. 统一 Screenshot IPC 路径校验。
3. Codex Session 增加 `realpath`。
4. 补路径相关测试。

完成后形成独立提交。

建议提交信息：

```text
fix: harden local file path validation
```

---

## 阶段 B：测试基础

1. 引入 Vitest。
2. 给安全工具补测试。
3. Session 解析函数抽成纯函数。
4. Token 统计逻辑补测试。
5. Role sanitize 补测试。

建议提交：

```text
test: add core unit test coverage
```

---

## 阶段 C：主进程模块化

建议按照：

```text
screenshots
→ codex
→ database
→ companion
→ system
```

逐步抽离。

每次只移动一个业务域。

建议提交：

```text
refactor: split screenshot main-process module
refactor: split codex session module
refactor: split companion module
```

---

## 阶段 D：Renderer 模块化

优先拆低耦合模块：

```text
annotation
→ screenshots
→ settings
→ companion
→ memory
```

不改变 HTML 结构优先。

---

## 阶段 E：CI 与代码规范

1. 增加 GitHub Actions。
2. 增加 ESLint。
3. 将测试和 lint 作为 PR 必检项。
4. 后续根据需要增加 build check。

---

## 阶段 F：类型治理

1. 核心对象加 JSDoc。
2. 新模块优先明确输入输出。
3. 新功能优先使用 TypeScript。
4. 不强制一次迁移全部旧代码。

---

# 九、任务执行模板

后续 Codex / Claude Code / Cursor 执行每个整改任务时，建议统一使用以下任务结构：

```markdown
## 任务目标

## 允许修改范围

## 禁止修改范围

## 当前问题

## 实现要求

## 验收标准

## 必须运行的验证

## 输出说明
```

这样可以避免 AI 在处理单点整改时顺手重构无关代码。

---

# 十、回归验证清单

每次重构后至少人工验证：

### 应用基础

- 应用能正常启动。
- 顶部悬浮窗正常。
- Peek 模式正常。
- 最小化 / 关闭正常。

### Codex

- 能识别当前 Session。
- Token 数据正常。
- 上下文占用正常。
- 续聊包可生成。
- 复制续聊包正常。
- 故障胶囊正常。

### 截图

- 全屏截图。
- 区域截图。
- OCR。
- 截图搜索。
- 收藏。
- 标签。
- 打开。
- 复制。
- 另存。
- 删除。
- 标注保存。

### 允码伴侣

- 角色读取。
- 角色新增。
- 角色导入导出。
- 角色切换。
- 工作来信。
- 提示语轮播。
- 设置保存。

### 数据

- SQLite 原有数据不丢失。
- 用户已有截图不丢失。
- 已有角色不丢失。
- 升级后无需用户手动迁移。

---

# 十一、风险与回滚策略

## 主要风险

### 1. 模块拆分导致循环依赖

处理方式：

- database、security、utils 等基础模块不得反向依赖业务模块。

### 2. 路径加固误伤正常文件

处理方式：

- 先覆盖测试。
- 明确每一类文件的合法根目录。
- Windows 特别验证盘符、大小写、路径分隔符。

### 3. Renderer 拆分导致 UI 初始化顺序变化

处理方式：

- 保留唯一 `app.js` 启动入口。
- 各模块仅暴露明确 init 函数。

### 4. 大范围改动难以回滚

处理方式：

- 每一阶段独立 commit。
- 禁止一个 commit 同时包含安全修复 + UI 改造 + 样式调整。

---

# 十二、完成定义

当以下条件满足时，本轮代码治理可视为第一阶段完成：

- [ ] 所有本地文件类 IPC 采用统一安全路径验证。
- [ ] Codex Session 使用真实路径校验。
- [ ] 路径相关安全逻辑存在自动化测试。
- [ ] `main.js` 至少拆出 screenshot、codex、database 三个模块。
- [ ] `renderer.js` 至少拆出 annotation、screenshots、settings。
- [ ] 建立 `pnpm test`。
- [ ] 建立 GitHub Actions CI。
- [ ] CI 对 main / PR 自动运行。
- [ ] 核心数据结构开始具备 JSDoc 或类型定义。
- [ ] 原有用户数据兼容。
- [ ] 主要功能完成一轮人工回归。

---

# 十三、优先级摘要

| 优先级 | 任务 | 目标 |
| --- | --- | --- |
| P0 | Screenshot IPC 路径统一校验 | 封堵本地文件访问边界 |
| P1 | Session realpath 校验 | 防止 symlink 绕过 |
| P1 | main.js 模块化 | 降低主进程复杂度 |
| P1 | renderer.js 模块化 | 降低 UI 逻辑耦合 |
| P1 | 自动化测试 | 为后续重构提供保护 |
| P2 | GitHub Actions | 建立多人 / 多 AI 协作质量门禁 |
| P2 | ESLint | 降低低级代码错误 |
| P2 | JSDoc / TypeScript | 增强长期维护能力 |

---

## 结论

YoonCode 当前不需要推倒重做。

最合适的演进路线是：

**先安全加固 → 再补测试 → 再模块拆分 → 再建立 CI → 最后逐步强化类型。**

这样既不影响现有产品迭代，又能让 YoonCode 后续继续扩展“允码伴侣、AI 协作记忆、多 AI 协作、上下文治理”等能力时保持代码可控。
