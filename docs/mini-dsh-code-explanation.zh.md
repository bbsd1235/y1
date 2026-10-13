# mini-dsh 代码详解与后续路线

本文档基于当前 mini-dsh 的实际代码，解释它如何通过 Plugin、Service、Context 和 Agent Loop 组成一个可运行的 Coding Agent。

当前项目已经能够完成：

- 通过插件加载 Session、Model、Tools 和 Agent Loop；
- 调用 DeepSeek 兼容的 Chat Completions API；
- 将模型工具调用转换为本地工具执行；
- 读取和写入 workspace 内的文件；
- 在 workspace 内执行 Shell 命令；
- 通过 CLI 进行交互；
- 通过 /cd 切换 Agent 的 workspace；
- 通过 JSONL 保存和恢复 Session；
- 通过 /sessions、/resume、/history 和 /new 管理会话。
- 通过 /delete <session-id> 删除持久化会话记录。
- 对文件写入和 Shell 执行进行权限确认。
- 使用模型轮次、工具调用数和时间三类执行预算；
- 预算耗尽后保存当前 Session，并通过 /continue 继续。
- 使用 Prompt Optimizer 将模糊需求改写成简洁的工作提示词。

CLI 当前提供两种模式：`normal` 直接运行 Agent Loop，`optimize` 先生成并展示优化后的工作提示词，确认后将其作为 Worker 的 system prompt 执行。旧的 Planner、TaskSpecification 和任务进度插件仍保留在源码中用于学习和独立测试，但不再由默认 Runtime 加载，也不会影响普通模式。

当前版本是教学型 Agent Harness，不是 DeepSeek Harness 的完整替代品。它保留了 DSH 最重要的插件化思想，并实现了基础持久化、可观测性和权限确认，但仍省略了真正的沙箱、流式输出和复杂上下文管理。

## 1. 项目结构

~~~text
mini-dsh/
├── src/
│   ├── context.ts
│   ├── plugin.ts
│   ├── plugin-registry.ts
│   ├── service-registry.ts
│   ├── runtime.ts
│   ├── cli.ts
│   ├── services/
│   │   ├── agent-loop.ts
│   │   ├── model.ts
│   │   ├── session-persistence.ts
│   │   ├── session.ts
│   │   ├── tools.ts
│   │   ├── permissions.ts
│   │   ├── task-progress.ts
│   │   └── task-specification.ts
│   └── plugins/
│       ├── agent-loop-plugin.ts
│       ├── deepseek-model-plugin.ts
│       ├── file-tools-plugin.ts
│       ├── mock-model-plugin.ts
│       ├── jsonl-session-plugin.ts
│       ├── permission-plugin.ts
│       ├── session-plugin.ts
│       ├── shell-tools-plugin.ts
│       ├── task-progress-plugin.ts
│       ├── task-update-tool-plugin.ts
│       └── tools-plugin.ts
├── docs/
└── package.json
~~~

可以把代码分成四层：

~~~text
运行入口层：cli.ts
组装层：runtime.ts
协调层：agent-loop-plugin.ts
能力层：session、model、tools、file-tools、shell-tools
基础设施层：context、plugin-registry、service-registry
~~~

最重要的关系是：

~~~text
MiniContext
├── ServiceRegistry
└── PluginRegistry
~~~

MiniContext 是插件运行时。插件通过它发现依赖、提供 Service、注册工具以及管理资源生命周期。

## 2. 三个核心概念

### 2.1 Plugin

Plugin 表示一段可以被加载和销毁的运行时能力。

一个插件通常负责：

- 创建一个 Service；
- 向已有 Service 注册能力；
- 注册事件监听器；
- 创建文件、网络连接或子进程等资源；
- 在销毁时释放自己创建的资源。

例如：

~~~text
sessionPlugin
  └── 创建 InMemorySessionService

fileToolsPlugin
  └── 获取 ToolsService 并注册 read_file 等工具
~~~

### 2.2 Service

Service 是插件之间协作时使用的稳定接口。Service 关注“能做什么”，不关注“由谁实现”。

例如：

~~~ts
interface ModelService {
  complete(request: ModelRequest): Promise<ModelResponse>
}
~~~

AgentLoop 只依赖 ModelService，因此可以替换为：

~~~text
MockModelService
DeepSeekModelService
OpenAICompatibleModelService
LocalModelService
~~~

### 2.3 Context

Context 是运行时容器，负责连接 Plugin 和 Service。

~~~ts
const context = new MiniContext()

context.use(sessionPlugin)
context.use(toolsPlugin)
context.use(deepSeekModelPlugin)
context.use(agentLoopPlugin)
~~~

插件通过 Context 获取 Service：

~~~ts
const model = context.get<ModelService>('model')
const tools = context.get<ToolsService>('tools')
~~~

三者的关系可以概括为：

~~~text
Plugin 提供或消费 Service
Service 定义插件之间的协作接口
Context 管理 Plugin 和 Service 的运行时关系
~~~

## 3. Service 的实现

### 3.1 Service Definition

mini-dsh 将 Service 接口放在 src/services/ 下。

| Service | 文件 | 作用 |
| --- | --- | --- |
| SessionService | src/services/session.ts | 保存对话历史 |
| ToolsService | src/services/tools.ts | 注册和执行工具 |
| ModelService | src/services/model.ts | 请求模型 |
| AgentLoopService | src/services/agent-loop.ts | 执行 Agent 任务 |

Service Definition 不应该包含具体实现。例如 ModelService 不应该知道 DeepSeek API URL，也不应该创建 fetch 请求。

### 3.2 Service Registry

文件：[src/service-registry.ts](../src/service-registry.ts)

ServiceRegistry 用 Map 保存服务：

~~~ts
export class ServiceRegistry {
  private readonly services = new Map<string, unknown>()

  provide<T>(name: string, service: T): ServiceDisposer {
    if (this.services.has(name)) {
      throw new Error('service already registered')
    }

    this.services.set(name, service)

    let disposed = false

    return () => {
      if (disposed) {
        return
      }

      disposed = true
      this.services.delete(name)
    }
  }

  get<T>(name: string): T {
    if (!this.services.has(name)) {
      throw new Error('service is not registered')
    }

    return this.services.get(name) as T
  }
}
~~~

它提供了四个重要行为：

1. Service 名称不能重复；
2. 获取不存在的 Service 会立即报错；
3. provide() 返回一个 disposer；
4. disposer 可以重复调用而不会重复产生副作用。

当前使用字符串作为 Service Key，类型安全还比较弱。后续可以集中管理 Key，或者实现泛型注册表。

### 3.3 Service Provider 和 Consumer

以 Model 为例：

~~~text
DeepSeekModelPlugin
  └── Provider：提供 model service

AgentLoopPlugin
  └── Consumer：消费 model service
~~~

以文件工具为例：

~~~text
ToolsPlugin
  └── Provider：提供 tools service

FileToolsPlugin
  └── Consumer：获取 tools service
  └── Contributor：向 tools 注册文件工具

AgentLoopPlugin
  └── Consumer：调用 tools.schemas() 和 tools.execute()
~~~

FileToolsPlugin 不提供新的 Service，而是向已有 Service 扩展能力。这是插件架构的重要使用方式。

## 4. Plugin 的实现

### 4.1 MiniPlugin 接口

文件：[src/plugin.ts](../src/plugin.ts)

~~~ts
export type PluginDisposer = () => void

export interface MiniPlugin {
  readonly name: string
  readonly dependencies?: readonly string[]
  setup(context: MiniContext): void | PluginDisposer
}
~~~

字段含义：

| 字段 | 作用 |
| --- | --- |
| name | 插件唯一名称 |
| dependencies | 插件需要的 Service 名称 |
| setup() | 加载插件时执行初始化 |

插件可以通过 Context 注册 Service 并返回 disposer：

~~~ts
setup(context) {
  const service = new SomeService()
  return context.provide('some-service', service)
}
~~~

也可以只执行初始化而不返回 disposer：

~~~ts
setup() {
  // 一次性初始化
}
~~~

### 4.2 Plugin 加载流程

文件：[src/plugin-registry.ts](../src/plugin-registry.ts)

插件加载顺序是：

~~~text
1. 检查 PluginRegistry 是否已经销毁
2. 检查插件名称是否为空
3. 检查插件名称是否重复
4. 检查 dependencies 是否都存在
5. 调用 plugin.setup(context)
6. 保存 setup 返回的 disposer
~~~

核心逻辑：

~~~ts
use(plugin, context) {
  assertRegistryIsActive()
  assertPluginName(plugin)
  assertPluginIsUnique(plugin)
  assertDependencies(plugin, context)

  const disposer = plugin.setup(context)
  const cleanup =
    typeof disposer === 'function' ? disposer : () => {}

  this.plugins.set(plugin.name, cleanup)
}
~~~

当前实现采用 fail-fast 策略。配置错误在运行时组装阶段暴露，而不是等到用户真正发送任务时才暴露。

### 4.3 插件依赖

Agent Loop 声明：

~~~ts
dependencies: ['session', 'model', 'tools']
~~~

以下顺序会失败：

~~~ts
const context = new MiniContext()
context.use(agentLoopPlugin)
~~~

正确顺序是：

~~~ts
context.use(sessionPlugin)
context.use(toolsPlugin)
context.use(deepSeekModelPlugin)
context.use(agentLoopPlugin)
~~~

当前依赖是 Service 名称，不会自动加载依赖，也不会等待未来才提供的 Service。

### 4.4 插件销毁

插件按照加载顺序逆序销毁：

~~~text
加载：
session -> tools -> model -> file-tools -> shell-tools -> agent-loop

销毁：
agent-loop -> shell-tools -> file-tools -> model -> tools -> session
~~~

逆序销毁保证使用者先于它依赖的提供者被清理。

例如 file-tools 注册的工具会先被注销，然后 tools Service 才被移除。

PluginRegistry.dispose() 还保证：

- disposer 抛错时继续清理其他插件；
- context.dispose() 可以重复调用。

## 5. 当前的具体插件

### 5.1 Session Plugin

文件：[src/plugins/session-plugin.ts](../src/plugins/session-plugin.ts)

提供：

~~~text
service name: session
implementation: InMemorySessionService
~~~

InMemorySessionService 使用数组保存消息，并在 append() 和 messages() 时复制消息，避免调用者直接修改内部历史。它实现了 `flush()` 空操作，使 Agent Loop 可以统一调用持久化检查点。

内存 Provider 适合测试和不需要恢复的运行。需要持久化时，Runtime 改为加载 `JsonlSessionService`，它同时提供 `session` 和 `session-persistence` 两个 service：

~~~text
JsonlSessionService
├── SessionService：供 Agent Loop 读取和追加消息
└── SessionPersistenceService：供 CLI 查询会话和 Provider 管理持久化
~~~

两个 Provider 不会同时加载。Runtime 根据 `sessionId` 选择 JSONL Provider，否则选择内存 Provider。

### 5.2 JSONL Session Plugin

文件：[src/plugins/jsonl-session-plugin.ts](../src/plugins/jsonl-session-plugin.ts)

每个会话对应一个 append-only 文件：

~~~text
~/.mini-dsh/sessions/<encoded-session-id>.jsonl
~~~

第一行是 header，记录格式版本、Session ID、工作目录和创建时间；之后每行是一条带序号和时间戳的消息记录：

~~~json
{"type":"session","version":1,"sessionId":"session-1","cwd":"/workspace","createdAt":1756000000000}
{"type":"message","sequence":1,"timestamp":1756000001000,"message":{"role":"user","content":"读取文件"}}
{"type":"message","sequence":2,"timestamp":1756000002000,"message":{"role":"assistant","content":null,"toolCalls":[{"id":"call-1","name":"read_file","arguments":{"path":"src/index.ts"}}]}}
{"type":"message","sequence":3,"timestamp":1756000003000,"message":{"role":"tool","content":"文件内容","toolCallId":"call-1"}}
~~~

追加时先完成文件写入和 `fsync`，成功后才更新内存数组。加载时校验 JSON、格式版本、Session ID、序号、消息角色、工具参数和 tool-call/result 配对关系。最后一个没有换行符且无法解析的半行会被视为崩溃尾部并截断；已经完整提交的坏行仍然会报错。

`src/services/session-persistence.ts` 定义了 Provider 抽象。Agent Loop 不依赖 `fs` 或 JSONL 文件名，因此未来可以在同一接口后增加 SQLite Provider。

### 5.3 Permission Plugin

文件：[src/services/permissions.ts](../src/services/permissions.ts)、[src/plugins/permission-plugin.ts](../src/plugins/permission-plugin.ts)

工具定义声明运行风险：`read_file` 和 `list_files` 是 `read-only`，`write_file` 是 `workspace-write`，`run_command` 是 `shell`。`PermissionService` 在 Agent Loop 调用工具前统一授权：只读工具自动允许，高风险工具交给 CLI 的确认处理器；没有交互处理器时默认拒绝。

授权不直接写在文件工具或 Shell 工具内部，因此工具执行逻辑和用户交互逻辑保持分离。拒绝操作不会中断 Agent Loop，而是生成 `tool error: permission denied ...` 写入 Session 并返回模型。模型可以据此解释未执行原因或选择其他方案。

### 5.2 Tools Plugin

文件：[src/plugins/tools-plugin.ts](../src/plugins/tools-plugin.ts)

提供：

~~~text
service name: tools
implementation: InMemoryToolsService
~~~

工具定义分为模型可见部分和进程内执行部分：

~~~ts
interface ToolDefinition extends ToolSchema {
  risk: 'read-only' | 'workspace-write' | 'shell'
  execute(args: ToolArguments): Promise<string>
}

interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}
~~~

模型只看到 ToolSchema，看不到 execute()。

执行工具：

~~~ts
await tools.execute('read_file', {
  path: 'src/index.ts',
})
~~~

这保证了模型只能提出工具调用，不能直接访问进程内函数。

### 5.3 File Tools Plugin

文件：[src/plugins/file-tools-plugin.ts](../src/plugins/file-tools-plugin.ts)

依赖：

~~~ts
dependencies: ['tools']
~~~

注册五个工具：

| 工具 | 功能 |
| --- | --- |
| read_file | 读取 UTF-8 文件 |
| write_file | 写入 UTF-8 文件 |
| edit_file | 精确替换文件中的一段文本 |
| delete_file | 删除 workspace 内的普通文件 |
| list_files | 列出目录内容 |

插件会检查路径是否位于 workspace 内，并检查已有符号链接的真实路径。

当前 write_file 要求父目录已经存在，不会自动创建所有父目录。
edit_file 要求旧文本恰好匹配一次；匹配不到或匹配多次都会拒绝修改。
delete_file 只允许删除文件，不允许删除目录。

### 5.4 Shell Tools Plugin

文件：[src/plugins/shell-tools-plugin.ts](../src/plugins/shell-tools-plugin.ts)

注册：

~~~text
run_command
~~~

Shell 工具使用 child_process.spawn()，返回：

~~~text
exit_code
timed_out
signal
stdout
stderr
~~~

支持：

- workspace 内的 cwd；
- 最大执行时间；
- stdout 和 stderr 长度限制；
- 非零退出码；
- 超时结果。

当前 shell 使用 shell: true，因此可以执行任意命令。workspace 路径限制不等于安全沙箱，当前仍然没有：

- 命令确认；
- 命令白名单；
- 网络限制；
- 资源限制；
- 完整子进程树回收；
- 容器或操作系统级沙箱。

### 5.5 Model Plugin

#### Mock Model

文件：[src/plugins/mock-model-plugin.ts](../src/plugins/mock-model-plugin.ts)

Mock Model 不访问网络，可以模拟：

- 最终回答；
- 工具调用；
- 多步工具调用；
- 模型错误。

它主要用于单元测试和无 API Key 的 CLI 验证。

#### DeepSeek Model

文件：[src/plugins/deepseek-model-plugin.ts](../src/plugins/deepseek-model-plugin.ts)

它提供：

~~~text
service name: model
implementation: DeepSeekModelService
~~~

请求流程：

~~~text
mini-dsh ModelRequest
        ↓
DeepSeek API request body

DeepSeek API response
        ↓
mini-dsh ModelResponse
~~~

它支持：

- 最终文本响应；
- 一个或多个工具调用；
- API Key、base URL 和模型名称配置；
- HTTP 错误；
- 非法 JSON 响应；
- 注入 mock fetch 的无 Key 测试。

Mock Model 和 DeepSeek Model 都提供 model Service，因此同一个 Context 中不能同时加载它们。

## 6. Agent Loop 详解

文件：[src/plugins/agent-loop-plugin.ts](../src/plugins/agent-loop-plugin.ts)

### 6.1 Agent Loop 的职责

Agent Loop 负责：

- 接收用户输入；
- 将用户输入写入 Session；
- 读取可用工具 schema；
- 请求模型；
- 处理最终回答；
- 执行模型要求的工具；
- 将工具结果写回 Session；
- 继续请求模型；
- 在超过最大步数时停止。

它不负责：

- 如何访问 DeepSeek；
- 如何读取文件；
- 如何执行 Shell；
- 如何持久化 Session；
- 如何显示 CLI。

### 6.2 Agent Loop 的 Service 依赖

文件：[src/services/agent-loop.ts](../src/services/agent-loop.ts)

~~~ts
export interface AgentLoopService {
  run(input: string): Promise<string>
}
~~~

Agent Loop 通过 Context 获取依赖：

~~~ts
const session = context.get<SessionService>('session')
const model = context.get<ModelService>('model')
const tools = context.get<ToolsService>('tools')
~~~

它不会直接实例化：

~~~ts
new DeepSeekModelService(...)
new InMemoryToolsService()
new InMemorySessionService()
~~~

因此替换 Model、Tools 或 Session Provider 时，Agent Loop 不需要修改。

### 6.3 Agent Loop 算法

~~~text
run(userInput):
    session.append(userInput)

    repeat at most maxModelRounds times:
        response = model.complete(
            messages = session.messages(),
            tools = tools.schemas()
        )

        if response is final:
            session.append(assistant response)
            return response.content

        if response is tool-call:
            session.append(assistant tool calls)

            for each call:
                try:
                    result = tools.execute(call.name, call.arguments)
                catch error:
                    result = "tool error: ..."

                session.append(tool result)

    throw maximum steps error
~~~

当前实现允许一次模型响应包含多个工具调用，并按顺序执行这些调用。

### 6.4 为什么工具错误要写回 Session

工具失败会转换为 tool 消息：

~~~text
tool error: tool "missing-tool" is not registered
~~~

这样模型可以看到失败原因，并尝试：

- 修正工具参数；
- 选择另一个工具；
- 向用户解释无法完成。

模型通信错误则直接抛出，因为这类错误通常不是模型通过工具调用能够修复的。

### 6.5 执行预算

当前默认最大模型轮次是 64：

~~~ts
const DEFAULT_MAX_MODEL_ROUNDS = 64
const DEFAULT_MAX_TOOL_CALLS = 128
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
~~~

maxModelRounds 表示最多请求模型多少次；maxToolCalls 单独限制工具调用总数；timeoutMs 限制一次运行的最长时间。一次模型响应可以包含多个工具调用，因此工具调用数不再与模型轮次混为一个预算。

CLI 可以覆盖：

~~~sh
npm run dev -- --max-model-rounds 64 --max-tool-calls 128 --timeout-ms 600000
~~~

达到任一预算时，Agent Loop 会抛出带有 reason 和 limit 的 AgentBudgetExceededError。CLI 保存当前 Session 已写入的用户消息、assistant 工具调用和 tool 结果，并提示 /continue。继续执行会复用同一任务标识，不会重复追加原始用户消息。

分离预算后，模型可以在一个轮次中请求多个独立工具，编码任务也不必把一个工具调用等同于一次模型决策。预算仍承担两个职责：

1. 允许编码任务执行多轮操作；
2. 防止模型和工具之间出现无限循环或失控消耗。

### 6.6 保留的 Planner 能力

项目仍保留 PlanningService、TaskSpecificationService、TaskProgressService 和 `task_update` 的实现，便于对照学习“Planning -> Specification -> Execution”方案。

这些插件只在对应测试或显式组装时加载。默认 `createAgentContext()` 不加载它们，因此 normal 模式不会收到 `task_update` 工具，也不会自动生成或确认计划。

若后续重新启用该方案，Task Specification 改变时应丢弃旧进度，同一规格恢复时才复用持久化状态。

### 6.7 权限授权范围和 Shell 风险

工具定义包含运行时风险级别。read-only、agent-state 和明确的 shell-low 命令自动允许；写文件和 shell-high 命令需要用户确认。CLI 支持三种确认范围：

~~~text
y / once     仅允许当前工具调用
a / task     允许当前任务，/continue 继续复用
s / session  允许当前 Session 中同类工具
n / deny     拒绝
~~~

run_command 对 pwd、ls、cat、rg、find 和 git status/diff/log 等简单只读命令采用低风险策略；删除、提权、网络、重定向、管道、复合命令、find -delete/-exec 和未知命令采用高风险策略。风险分类只减少无副作用读取的确认，不替代真正的进程沙箱。

后续可以继续增加：

- 工具调用计数；
- 重复调用检测；
- Token 预算；
- 更清晰的终止原因。

### 6.8 Prompt Optimizer

Prompt Optimizer 是一个轻量的前置服务，不是第二个 Agent。它接收用户原始需求和当前 workspace 路径，通过 ModelService 生成一段更清晰的工作提示词。它不接收工具、不执行文件操作、不生成任务列表，也不决定 Worker 的实现方式。

CLI 使用 `--mode optimize` 或交互命令 `/mode optimize` 时，会先生成并展示优化结果。交互终端确认后，CLI 将原始用户需求作为 user 消息、优化结果作为本次 Worker 的 system prompt，再启动同一个 Agent Loop；`--once` 模式自动确认并直接执行。Agent Loop 和普通模式的工具调用、权限确认及 Session 机制保持不变。

~~~text
用户需求 + workspace
  -> PromptOptimizerService
  -> 优化后的工作提示词
  -> CLI 展示与确认
  -> AgentLoop(systemPrompt)
~~~

## 7. Session 消息协议

文件：[src/services/session.ts](../src/services/session.ts)

当前消息协议可以表达：

~~~ts
type SessionMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | {
      role: 'assistant'
      content: null
      toolCalls: readonly SessionToolCall[]
    }
  | {
      role: 'tool'
      content: string
      toolCallId: string
    }
~~~

工具调用必须拆成两类消息：

~~~text
assistant:
  content: null
  toolCalls:
    - id: call-1
      name: read_file
      arguments: { path: "src/index.ts" }

tool:
  content: "文件内容..."
  toolCallId: call-1
~~~

它们可以直接映射到 DeepSeek API 的 assistant tool_calls 和 tool tool_call_id 字段。

这比旧版本把工具调用序列化到 assistant 普通文本中更可靠，因为模型适配器不需要从字符串猜测工具调用。

## 8. 一次完整运行流程

### 8.1 启动阶段

文件：[src/runtime.ts](../src/runtime.ts)

~~~ts
context.use(sessionPlugin)
context.use(toolsPlugin)
context.use(createDeepSeekModelPlugin())
context.use(createFileToolsPlugin({ rootDir }))
context.use(createShellToolsPlugin({ rootDir }))
context.use(createAgentLoopPlugin({
  maxModelRounds: 64,
  maxToolCalls: 128,
  timeoutMs: 600000,
}))
~~~

最终结构：

~~~text
MiniContext
├── session -> InMemorySessionService
├── tools -> InMemoryToolsService
├── model -> DeepSeekModelService
└── agent-loop -> DefaultAgentLoopService

tools 内部注册：
├── read_file
├── write_file
├── edit_file
├── delete_file
├── list_files
└── run_command
~~~

### 8.2 用户发送任务

例如：

~~~text
在当前工作环境下创建一个贪吃蛇小游戏，支持在终端上运行游玩
~~~

CLI 调用：

~~~ts
await agentLoop.run(input)
~~~

### 8.3 模型决定调用工具

模型可能返回：

~~~text
tool-call(write_file, {
  path: "snake.py",
  content: "..."
})
~~~

Agent Loop 将 assistant 工具调用写入 Session，然后调用：

~~~ts
await tools.execute('write_file', {
  path: 'snake.py',
  content: '...',
})
~~~

### 8.4 工具结果回传

工具结果写入 Session：

~~~text
tool:
  content: wrote file: snake.py
  toolCallId: call-1
~~~

下一次模型请求会携带：

- 用户任务；
- assistant 工具调用；
- tool 执行结果；
- 当前可用工具 schema。

### 8.5 模型继续工作

典型过程可能是：

~~~text
1. write_file 创建游戏源码
2. run_command 运行语法检查
3. read_file 读取错误相关文件
4. edit_file 精确修复代码
5. run_command 启动测试
6. final 返回完成说明
~~~

最终模型返回 final，Agent Loop 保存 assistant 消息并返回 CLI。

## 9. CLI 和动态 workspace

文件：[src/cli.ts](../src/cli.ts)

CLI 负责：

- 解析启动参数；
- 创建运行时；
- 接收用户输入；
- 显示模型回答；
- 处理交互命令；
- 在退出时销毁 Context。

CLI 不负责实现文件读取、Shell 执行或模型请求。

### 9.1 /cd 的实现思路

文件工具和 Shell 工具在插件初始化时保存 rootDir，因此单纯执行：

~~~ts
process.chdir(newDirectory)
~~~

不能让已经创建的工具自动切换 workspace。

当前实现的流程是：

~~~text
/cd <path>
  ↓
验证目标目录
  ↓
创建新的 MiniContext
  ↓
重新加载所有插件
  ↓
销毁旧 MiniContext
  ↓
更新提示符和 workspace 状态
~~~

切换 workspace 会重置 Session，避免同一个 Session 混合两个工作区的上下文。

## 10. mini-dsh 与 DeepSeek Harness 的对应关系

| mini-dsh | DeepSeek Harness / Cordis 思想 |
| --- | --- |
| MiniContext | Cordis Context |
| context.use(plugin) | ctx.plugin() |
| ServiceRegistry | Service 注入与发现 |
| context.provide() | 提供运行时服务 |
| context.get() | 获取运行时服务 |
| PluginRegistry | 插件加载和生命周期管理 |
| dependencies | 插件依赖声明 |
| disposer | Fiber/effect 清理机制的简化版 |
| ToolsService | 工具能力注册中心 |
| AgentLoopService | Agent Loop 协调器 |
| DeepSeekModelService | 模型 Provider |
| FileToolsPlugin | 文件能力插件 |
| ShellToolsPlugin | Shell 能力插件 |

mini-dsh 已经体现了 DSH 最重要的思想：

> Agent Loop 不应该直接拥有所有能力，能力由插件提供，插件通过 Context 组合成运行时。

但两者仍有明显差距。DSH/Cordis 还具有：

- Fiber 级生命周期；
- Scoped Context；
- 动态依赖解析；
- Effect 自动收集；
- 事件和 Waterfall；
- 配置驱动的插件组合；
- 持久化 Session Log；
- 权限和交互确认；
- 沙箱和进程树管理；
- 上下文压缩；
- 子 Agent；
- LSP、Web、Filesystem、Shell 等能力 Seam。

因此，mini-dsh 适合作为最小实现，不应该声称已经复刻完整 DSH。

## 11. 当前实现的不足

### 11.1 Service Key 是普通字符串

当前调用方式：

~~~ts
context.get<ModelService>('model')
~~~

字符串拼写错误只能在运行时发现。后续可以集中管理 Key：

~~~ts
export const SERVICE_KEYS = {
  model: 'model',
  tools: 'tools',
  session: 'session',
  agentLoop: 'agent-loop',
} as const
~~~

### 11.2 Session 持久化仍是简化实现

当前已经通过 JSONL 保存消息、工具调用和工具结果，并支持通过 Session ID 恢复。它仍是单机同步文件 Provider，没有 DSH 的事件溯源 Session、异步写入批处理、SQLite 索引、压缩和完整 crash-recovery 状态机。生产版本还需要处理并发写入、文件锁、权限和更细粒度的事件日志。

### 11.3 Shell 不是安全沙箱

当前只限制 workspace cwd，不能阻止命令删除文件、访问网络、启动后台进程或消耗过多资源。准确的描述应该是“具有 workspace cwd 限制和超时控制的 Shell 工具”，而不是“安全沙箱”。

当前权限确认只能阻止未经用户允许的调用，不能限制已批准命令本身的能力；真正的隔离仍需要进程沙箱、文件系统策略、网络策略和资源限制。

### 11.4 可观测性仍是基础实现

当前已经通过 Agent Event Service 展示：

- 第几次模型请求；
- 每次请求耗时；
- 调用了哪个工具；
- 工具执行耗时；
- Agent 为什么停止。

事件目前只在内存中实时分发，没有独立 Metrics Provider、持久化查询和 Token 使用量统计。

### 11.5 没有流式输出和取消

当前模型请求是非流式的，CLI 只能显示简单的 thinking 状态。后续可以加入 SSE、增量输出、Ctrl-C 取消和 AbortSignal。

## 12. 面向简历项目的开发路线

不建议只继续增加工具数量。简历项目更重要的是证明架构清晰、边界明确、测试充分，并且主动处理安全和可靠性问题。

### 阶段一：完善基础运行时

目标：把教学实现变成可靠的 Agent Runtime。

建议实现：

1. 集中管理 Service Key；
2. 增加插件加载失败诊断；
3. 增加结构化 Runtime Event；
4. 记录模型请求、工具调用和耗时；
5. 增加统一错误类型；
6. 增加 Agent Loop 集成测试。

建议的事件类型：

~~~ts
type AgentEvent =
  | { type: 'model-request-start'; step: number }
  | { type: 'model-response'; step: number }
  | { type: 'tool-start'; name: string }
  | { type: 'tool-end'; name: string; durationMs: number }
  | { type: 'agent-final'; content: string }
  | { type: 'agent-error'; error: string }
~~~

### 阶段二：增强持久化 Session

基础目标已经完成：让 Agent 任务可以恢复，而不是随 CLI 退出丢失。

当前实现使用 JSONL：

~~~text
sessions/<session-id>.jsonl
~~~

建议实现：

- SessionPersistenceService 接口；
- JsonlSessionService Provider；
- Session ID 和格式版本；
- append-only 消息记录；
- CLI 启动时恢复；
- /new、/resume、/history、/sessions 和 /delete 命令；
- 非法 JSON、序号和工具调用关系校验；
- 完整行与崩溃半行的区别处理。

下一步可以增加 SQLite Provider、异步 flush、文件锁、Session fork、历史压缩和基于事件的消息投影。

### 阶段三：增强安全和权限系统

基础目标已经完成：让 Agent 执行 Shell 和写文件前经过权限确认。

建议实现：

- PermissionService；
- 文件写入确认；
- Shell 命令确认；
- 只读、workspace 写入、完全允许三种模式；
- 命令超时；
- 输出大小限制；
- 子进程组回收；
- 危险命令提示；
- 工具调用审计记录。

当前实现的高风险工具没有用户确认处理器时默认拒绝，权限拒绝会作为工具错误返回模型。后续可以增加 Session 级授权记忆、命令风险分析、diff 预览、拒绝事件持久化和真正的进程/文件系统沙箱。

安全逻辑不应该硬编码进 Agent Loop。权限应该是独立 Service 或 Plugin，由工具执行前消费它。

### 阶段四：模型能力增强

目标：让模型 Provider 更接近生产实现。

建议实现：

- 流式响应；
- 请求超时；
- 指数退避重试；
- 429 限流处理；
- Token 使用统计；
- 最大上下文长度检查；
- 多模型 Provider；
- 模型故障切换。

同时保持 DeepSeek API 的 wire format 和内部 ModelRequest 分离。

### 阶段五：上下文管理

目标：解决长任务中 Session 不断变大的问题。

建议实现：

- 上下文长度估算；
- 历史消息裁剪；
- 摘要压缩；
- 工具输出压缩；
- 最近操作保留；
- compaction 事件记录。

### 阶段六：更多 Coding Agent 能力

按能力边界继续增加插件：

~~~text
GitPlugin
  └── status、diff、commit、log

SearchPlugin
  └── grep、glob、代码搜索

LspPlugin
  └── diagnostics、definition、references

WebPlugin
  └── search、fetch

SubagentPlugin
  └── 将子任务委托给另一个 Agent Loop
~~~

每种能力都保持：

~~~text
Service Definition
Service Provider
Consumer
Plugin lifecycle
Focused tests
~~~

不要把所有工具继续堆进一个 tools-plugin.ts。

## 13. 适合作为简历项目的描述

当前版本更准确的描述是：

> 基于 TypeScript 实现最小插件化 Coding Agent Harness。实现了 Context/Plugin/Service 运行时、可替换的 Mock/DeepSeek 模型 Provider、结构化 tool-calling 协议、workspace 文件工具、Shell 工具和 CLI 交互入口。

完成持久化、权限和可观测性之后，可以升级为：

> 基于 TypeScript 实现插件化 Coding Agent Harness。通过 Context 管理插件生命周期和 Service 依赖，构建了可替换的模型 Provider、Session Provider 和工具注册系统；实现 DeepSeek tool-calling 集成、workspace 文件操作、Shell 执行、Agent Loop 多步推理、CLI 交互、Session 持久化和工具权限控制，并通过集成测试验证核心运行流程。

简历中的每个能力都应该能在代码和测试中找到对应实现。

## 14. 继续学习 DeepSeek Harness 的源码路径

不需要从头阅读 DSH 全部源码。可以按照 mini-dsh 已经建立的概念寻找对应实现：

1. 阅读 DSH 架构文档，理解 Capability、Service Definition、Provider 和 Consumer；
2. 对照 Cordis 的 Context、Plugin、Fiber 和 Effect 生命周期；
3. 阅读 DSH Agent Loop，重点看它如何获取 Model、Session 和 Tools；
4. 阅读 Session Log 和事件定义，理解模型可见内容为什么必须可恢复；
5. 阅读工具注册和工具 Consumer，比较权限、工具结果和展示层；
6. 阅读 Shell、Filesystem、Subprocess Provider，理解安全边界；
7. 最后阅读配置加载、Preset、Bundle 和 CLI 组装。

建议的对照入口：

| 学习问题 | mini-dsh 入口 | DSH 中寻找的方向 |
| --- | --- | --- |
| 插件如何加载 | plugin-registry.ts | Cordis plugin/fiber |
| Service 如何发现 | context.ts | Cordis service/context |
| Agent 如何循环 | agent-loop-plugin.ts | core agent-loop |
| 工具如何暴露给模型 | services/tools.ts | core tools |
| 工具如何执行 | file-tools、shell-tools | capability Provider/Consumer |
| Session 如何保存 | session-plugin.ts | session log/persistence |
| CLI 如何组装 | runtime.ts、cli.ts | boot/preset/bundle |

## 15. 常用验证命令

~~~sh
npm run typecheck
npm test
npm run dev -- --mock "hello"
npm run dev -- "读取 src/index.ts 并总结"
~~~

交互模式中：

~~~text
/help
/pwd
/cd ..
/sessions
/delete <session-id>
/clear
/exit
~~~

当前 mini-dsh 最重要的学习成果不是工具数量，而是建立了下面这条完整链路：

~~~text
插件组合
  -> Service 注入
  -> Agent Loop 协调
  -> Model tool-call
  -> Tool 执行
  -> Session 记录
  -> Model 继续决策
  -> CLI 输出
~~~

这条链路就是继续理解 DeepSeek Harness 其他能力的主线。
