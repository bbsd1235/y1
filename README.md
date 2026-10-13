# mini-dsh

> 插件化架构

mini-dsh 是一个基于 DeepSeek Harness 思想实现的轻量级 Coding Agent Harness。它的重点不是复刻完整的 dsh，而是用较少的代码展示一套可理解、可扩展的 Agent Runtime：通过插件提供 Model、Tool、Session、Context Manager 和 Agent Loop 等能力，再由 Runtime 负责组装它们。

这个项目适合作为学习 Agent Harness、插件化架构、工具调用、会话恢复和上下文管理的示例项目。

## 项目目标

mini-dsh 从 DeepSeek Harness 中抽取了几个重要思想：

- 一切皆插件：模型、工具、权限、会话、事件和 Agent Loop 都通过插件注册。
- Service 与 Plugin 分离：Service 定义能力接口，Plugin 负责创建实现并注入 Runtime。
- Agent Loop 保持通用：Loop 不关心具体模型和工具，只依赖 `ModelService`、`ToolsService`、`SessionService` 等抽象。
- Session 与 Context 分离：Session 保存完整历史，Context Manager 构建本次发送给模型的上下文投影。
- 工具调用是模型协议的一部分：模型通过结构化 tool call 请求工具，Loop 执行工具并把结果追加回会话。
- 安全和可观测性属于运行时能力：权限确认、预算限制、取消信号和结构化事件不耦合到某一个具体工具。

## 当前功能

- DeepSeek Chat Completions 模型适配，默认模型为 `deepseek-v4-flash`。
- Mock Model，便于不配置 API Key 时演示 Runtime 和 CLI。
- Agent Loop：模型请求、工具调用、工具结果回传和最终回答。
- 文件工具：`read_file`、`write_file`、`edit_file`、`delete_file`、`list_files`。
- Shell 工具：`run_command`，默认限制在 workspace 内执行。
- 工具权限：只读工具自动允许，写文件和高风险 Shell 操作支持单次、当前任务、当前 Session 授权。
- JSONL Session：保存用户消息、assistant 工具调用、工具结果、任务规格和任务进度，并支持恢复。
- Agent 运行预算：最大模型轮次、最大工具调用数和总超时时间。
- `/continue`：预算耗尽后继续执行 checkpoint。
- Prompt Optimizer：把模糊的用户需求改写为清晰的 Worker system prompt，不替 Worker 制定详细计划。
- Context Manager：粗略估算 Token，达到 80% 使用率时自动生成历史摘要，只保留最近 12 条消息，并截断过大的工具结果。
- `/context`：查看最近一次模型上下文的估算用量。
- `/compact`：手动生成历史摘要并更新模型上下文投影。
- 结构化 Agent 事件：CLI 可以显示 Agent 启动、模型请求、模型响应、工具执行和最终完成等生命周期事件。
- CLI 工作目录切换、Session 列表、Session 删除、Session 恢复和历史查看。

## 架构概览

```text
CLI
 │
 ▼
Runtime ──────────────── 负责组装插件
 │
 ├── Session Plugin ──── 完整对话历史和 JSONL 持久化
 ├── Model Plugin ────── DeepSeek 或 Mock Model
 ├── Tools Plugin ────── 工具注册表和执行入口
 ├── File Tools ──────── 文件读写、编辑、删除、列表
 ├── Shell Tools ─────── workspace 内命令执行
 ├── Permission Plugin ── 工具权限判断和授权缓存
 ├── Context Manager ──── 构建和压缩模型上下文
 ├── Prompt Optimizer ── 优化用户需求
 ├── Agent Events ────── 生命周期事件总线
 └── Agent Loop ──────── 驱动 Model -> Tool -> Model 循环
```

Runtime 的默认加载顺序是：

```text
session
  -> agent-events
  -> permissions
  -> tools
  -> model
  -> context-manager
  -> prompt-optimizer
  -> file-tools
  -> shell-tools
  -> agent-loop
```

插件依赖通过 `dependencies` 声明。插件加载时，`MiniContext` 会检查所需 Service 是否已经存在；插件初始化成功后，可以通过 `context.provide()` 注册 Service，并在销毁时移除资源。

## 源码导读

### 插件和 Context

- `src/plugin.ts`：定义 `MiniPlugin` 和插件清理函数。
- `src/plugin-registry.ts`：负责插件加载、依赖检查、重复注册检查和逆序销毁。
- `src/service-registry.ts`：保存 Service 实例并处理重复注册。
- `src/context.ts`：向插件提供 `use`、`provide`、`get`、`has` 和 `dispose`。
- `src/runtime.ts`：组装默认 Runtime，是理解整个项目启动过程的入口。

### Agent Loop

`src/plugins/agent-loop-plugin.ts` 实现核心循环：

```text
接收用户输入
  -> 写入 Session
  -> ContextManager.build()
  -> ModelService.complete()
  -> final：保存 assistant 回答并结束
  -> tool-call：检查预算和权限
  -> ToolsService.execute()
  -> 保存 tool 结果
  -> 回到 ContextManager.build()
```

Loop 只知道 Service 接口，不知道 DeepSeek API 的具体字段，也不知道文件工具如何实现。这使得 Mock Model、DeepSeek Model 和未来的其他模型可以互换。

默认 Agent 预算为：

- 最大模型请求轮次：64。
- 最大工具调用数：128。
- 单次运行总超时：10 分钟。

### Model Plugin

- `src/services/model.ts`：定义 `ModelRequest`、`ModelResponse` 和 `ModelService`。
- `src/plugins/deepseek-model-plugin.ts`：将 mini-dsh 消息和工具 Schema 转换为 DeepSeek API 格式，并将响应转换回统一的 `final` 或 `tool-call`。
- `src/plugins/mock-model-plugin.ts`：提供确定性模型实现，适合本地演示和单元测试。

工具调用不是通过系统提示词伪造的，而是通过模型 API 的结构化 `tools` 和 `tool_calls` 字段完成。系统提示词可以说明工具使用原则，但工具名称、参数 Schema 和调用结果由模型协议传递。

### Tool Plugin

`src/services/tools.ts` 定义工具的统一协议：

```ts
interface ToolDefinition extends ToolSchema {
  risk: ToolRisk
  execute(args: ToolArguments, signal?: AbortSignal): Promise<string>
}
```

工具注册后同时拥有两部分：

- `ToolSchema`：发送给模型，包含名称、描述和参数 JSON Schema。
- `execute()`：只在 Runtime 内部执行，不暴露给模型。

当前文件工具由 `src/plugins/file-tools-plugin.ts` 提供，Shell 工具由 `src/plugins/shell-tools-plugin.ts` 提供。文件工具和 Shell 工具都会校验规范化路径，阻止访问 workspace 外部路径。

### Permission Plugin

`src/plugins/permission-plugin.ts` 根据工具风险决定是否执行：

- `read-only` 和 `agent-state`：自动允许。
- `shell-low`：自动允许。
- `workspace-write`、`shell`、`shell-high`：需要用户确认。
- `allow-once`：只允许当前工具调用。
- `allow-run`：允许当前任务后续同类调用。
- `allow-session`：允许当前 Session 后续同类调用。
- 拒绝后不会执行工具，而是把权限错误作为 tool result 返回给模型。

### Session Plugin

`src/plugins/session-plugin.ts` 提供内存 Session，`src/plugins/jsonl-session-plugin.ts` 提供 JSONL 持久化 Session。

Session 保存：

- 用户消息。
- assistant 的普通回答。
- assistant 的结构化工具调用。
- 工具执行结果和错误。
- Task Specification 和 Task Progress。
- Session header 中的 Session ID、工作目录和创建时间。

默认持久化目录为：

```text
~/.mini-dsh/sessions/
```

Session 采用追加式 JSONL。Session 负责保存事实上的完整历史，不负责决定本次模型请求要携带哪些消息。

### Context Manager

`src/services/context-manager.ts` 定义 Context Manager Service，`src/plugins/context-manager-plugin.ts` 提供实现。

每次模型请求前，Context Manager 会：

1. 读取完整 Session 历史。
2. 复制工具 Schema、Task Specification 和 Task Progress。
3. 粗略估算 system prompt、消息、工具 Schema 和任务信息的 Token 数。
4. 用量低于 80% 时直接构建模型上下文。
5. 用量达到 80% 时调用当前 Model Service 生成历史摘要。
6. 将旧消息摘要加入 system prompt。
7. 只保留最近 12 条消息。
8. 对过大的工具结果保留头尾并截断。

压缩只改变发送给模型的 Context 投影，不修改 Session JSONL。这样既能保留完整可恢复历史，又能避免上下文无限增长。摘要状态会在 Context Manager 内存中增量更新，后续只总结新移出最近窗口的消息。

## 安装

要求 Node.js 22 或更高版本。

```bash
npm install
```

## 使用 Mock Model 演示

Mock Model 不需要 API Key，可用于验证 CLI、插件组装、Session 和基础 Agent Loop：

```bash
npm run dev -- --mock --once "请检查当前 workspace"
```

启动交互模式：

```bash
npm run dev -- --mock
```

启动后可以输入普通任务，例如：

```text
列出当前项目的 TypeScript 文件，并说明项目结构
```

Mock Model 主要用于演示运行链路，不具备真实模型的编码能力。要执行真实 Coding Agent 任务，请使用 DeepSeek Model。

## 使用 DeepSeek Model

设置 API Key：

```bash
export DEEPSEEK_API_KEY="your-api-key"
```

启动交互模式：

```bash
npm run dev -- --workspace /path/to/project
```

执行一次任务并退出：

```bash
npm run dev -- \
  --workspace /path/to/project \
  --once "检查项目并修复明显的 TypeScript 类型错误"
```

默认模型为 `deepseek-v4-flash`，默认 API 地址为 `https://api.deepseek.com`。也可以通过环境变量覆盖地址：

```bash
export DEEPSEEK_BASE_URL="https://api.deepseek.com"
```

## CLI 参数

```text
--mock                 使用 Mock Model
--mode normal          使用普通模式
--mode optimize        先调用 Prompt Optimizer，再运行 Worker
--workspace <path>     设置初始 workspace
--max-model-rounds N   设置模型请求轮次上限
--max-tool-calls N     设置工具调用数上限
--timeout-ms N         设置一次任务的总超时时间
--session <id>         打开或创建指定持久化 Session
--session-dir <path>   设置 JSONL Session 目录
--once <prompt>        执行一次任务后退出
--help                 查看帮助
```

## 交互命令

```text
/mode normal|optimize   切换 Agent 模式
/cd <path>               切换 workspace，并创建新的 Session
/pwd                     查看当前 workspace
/sessions                列出持久化 Session
/resume <id>             恢复指定 Session
/delete <id>             删除指定 Session
/history                 查看当前 Session 的完整消息历史
/context                 查看最近一次模型上下文用量
/compact                 立即生成历史摘要并压缩上下文
/continue                继续上一次预算耗尽的任务
/new                     创建新的 Session
/clear                   清屏并重新显示欢迎信息
/help                    查看交互帮助
/exit                    退出 mini-dsh
```

### Prompt Optimizer 模式

普通模式直接把用户输入交给 Worker。Optimize 模式先让 Prompt Optimizer 根据用户输入和当前 workspace 生成更清晰的工作提示词，并在 CLI 中展示供用户确认。

Prompt Optimizer 只负责：

- 澄清用户目标。
- 补充当前 workspace 信息。
- 增加合理的验证要求。
- 处理明显但有限的歧义。

它不会制定详细执行计划、指定具体文件或代替 Worker 编写代码。真正的规划、工具选择、实现和修复仍由 Working Agent 完成。

### 上下文命令

`/context` 展示最近一次模型请求使用的 Context 快照，包括估算 Token、窗口上限、使用比例、完整历史消息数、实际发送消息数和各部分占用。

`/compact` 会立即调用 Model Service 生成旧消息摘要。它不会删除 Session 消息，也不会把摘要写入 Session 文件；摘要只作为后续模型请求的 system prompt 内容存在。

## 类型检查

源码使用 TypeScript 严格模式和 NodeNext ESM：

```bash
npm run typecheck
```

本仓库的源代码发布版本不包含本地测试文件和 `workspace` 示例目录。开发测试时可以在本地保留测试文件，并执行：

```bash
npm test
```

## 扩展方式

新增能力时，建议遵循 Service Definition、Plugin Provider、Consumer 的分工：

1. 在 `src/services` 定义最小能力接口和数据类型。
2. 在 `src/plugins` 实现一个提供该 Service 的插件。
3. 让 Agent Loop 或其他组件只依赖 Service 接口。
4. 在 `runtime.ts` 中按依赖顺序加载插件。
5. 对模型、工具、持久化和进程边界进行输入校验。

可以继续扩展的方向包括：流式模型输出、更精确的 tokenizer、摘要持久化、SQLite Session Provider、工具并行执行、循环检测、子 Agent、LSP 工具、Web 工具和更完善的事件指标。

## 项目与 DeepSeek Harness 的关系

mini-dsh 不是 DeepSeek Harness 的替代品，也没有实现 Cordis 的完整生命周期、作用域和复杂插件组合能力。它保留了最适合学习和简历展示的核心思想：能力通过插件注入，Agent Loop 依赖抽象 Service，Session 与 Context 分离，模型通过结构化工具调用驱动外部能力。

如果继续完善，可以将当前 `MiniContext` 演进为更完整的插件运行时，并逐步增加事件持久化、配置化插件组合、Provider 替换和可观测性指标。
