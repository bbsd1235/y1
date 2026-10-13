import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { MiniContext } from './context.js'
import {
  createAgentLoopPlugin,
} from './plugins/agent-loop-plugin.js'
import { agentEventsPlugin } from './plugins/events-plugin.js'
import {
  createDeepSeekModelPlugin,
} from './plugins/deepseek-model-plugin.js'
import {
  createFileToolsPlugin,
} from './plugins/file-tools-plugin.js'
import {
  createMockModelPlugin,
} from './plugins/mock-model-plugin.js'
import { promptOptimizerPlugin } from './plugins/prompt-optimizer-plugin.js'
import { contextManagerPlugin } from './plugins/context-manager-plugin.js'
import {
  createShellToolsPlugin,
} from './plugins/shell-tools-plugin.js'
import { createSessionPlugin, sessionPlugin } from './plugins/session-plugin.js'
import { createPermissionPlugin } from './plugins/permission-plugin.js'
import { toolsPlugin } from './plugins/tools-plugin.js'
import type { ToolApprovalHandler } from './services/permissions.js'

/**
 * 模型类型。
 */
export type RuntimeModel = 'mock' | 'deepseek'

/**
 * Agent Runtime 配置。
 */
export interface RuntimeOptions {
  /**
   * 使用的模型实现。
   *
   * 默认使用 DeepSeek。
   */
  readonly model?: RuntimeModel

  /**
   * 文件和 Shell 工具允许访问的根目录。
   *
   * 默认使用当前工作目录。
   */
  readonly workspaceRoot?: string

  /** Agent Loop 最大模型请求轮次。 */
  readonly maxModelRounds?: number

  /** 一次 Agent Run 允许执行的最大工具调用数。 */
  readonly maxToolCalls?: number

  /** 一次 Agent Run 的最长时间。 */
  readonly timeoutMs?: number

  /** 可选的持久化会话 id；未提供时使用内存 Session。 */
  readonly sessionId?: string

  /** JSONL 会话目录；未提供时默认为 ~/.mini-dsh/sessions。 */
  readonly sessionDir?: string

  /** 交互模式下用于确认高风险工具的处理函数。 */
  readonly approveTool?: ToolApprovalHandler
}

/**
 * 创建 mini-dsh 运行时。
 *
 * 插件加载顺序：
 *
 * 1. session（内存或 JSONL Provider）；
 * 2. agent-events；
 * 3. permissions；
 * 4. tools；
 * 5. model；
 * 6. context-manager；
 * 7. prompt-optimizer；
 * 8. file-tools；
 * 9. shell-tools；
 * 10. agent-loop。
 *
 * @param options - Runtime 配置。
 * @returns 已完成插件组装的 Context。
 */
export function createAgentContext(
  options: RuntimeOptions = {},
): MiniContext {
  const context = new MiniContext()
  const model = options.model ?? 'deepseek'
  const workspaceRoot = options.workspaceRoot

  try {
    if (options.sessionId === undefined) {
      context.use(sessionPlugin)
    } else {
      context.use(
        createSessionPlugin({
          rootDir: options.sessionDir ?? resolve(homedir(), '.mini-dsh/sessions'),
          sessionId: options.sessionId,
          cwd: workspaceRoot ?? process.cwd(),
        }),
      )
    }
    context.use(agentEventsPlugin)
    context.use(createPermissionPlugin({ approve: options.approveTool }))
    context.use(toolsPlugin)

    if (model === 'mock') {
      context.use(createMockModelPlugin())
    } else {
      context.use(createDeepSeekModelPlugin())
    }

    context.use(contextManagerPlugin)
    context.use(promptOptimizerPlugin)

    context.use(
      createFileToolsPlugin({
        rootDir: workspaceRoot,
      }),
    )

    context.use(
      createShellToolsPlugin({
        rootDir: workspaceRoot,
      }),
    )

    context.use(
      createAgentLoopPlugin({
        maxModelRounds: options.maxModelRounds,
        maxToolCalls: options.maxToolCalls,
        timeoutMs: options.timeoutMs,
      }),
    )

    return context
  } catch (error: unknown) {
    // 组装失败时清理已经成功加载的插件。
    context.dispose()
    throw error
  }
}
