import { randomUUID } from 'node:crypto'
import type { MiniPlugin } from '../plugin.js'
import {
  AgentBudgetExceededError,
} from '../services/agent-loop.js'
import type {
  AgentLoopService,
  AgentRunOptions,
} from '../services/agent-loop.js'
import type { AgentEventService } from '../services/events.js'
import type {
  ContextManagerService,
} from '../services/context-manager.js'
import type { PermissionService } from '../services/permissions.js'
import type {
  ModelService,
  ModelToolCall,
} from '../services/model.js'
import type { SessionService } from '../services/session.js'
import type { ToolsService } from '../services/tools.js'
import type { TaskProgressService } from '../services/task-progress.js'

/**
 * Agent Loop 配置。
 */
export interface AgentLoopPluginOptions {
  /**
   * 一次任务最多请求模型多少次。
   */
  readonly maxModelRounds?: number
  /** 一次运行允许执行的最大工具调用数。 */
  readonly maxToolCalls?: number
  /** 一次运行的最长时间。 */
  readonly timeoutMs?: number
}

/**
 * 默认最大模型轮次。
 *
 * Coding Agent 任务通常需要多轮文件操作、命令执行和错误修复。
 * 64 次模型轮次可以覆盖常见编码任务，同时仍保留终止上限。
 */
const DEFAULT_MAX_MODEL_ROUNDS = 64
const DEFAULT_MAX_TOOL_CALLS = 128
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Agent Loop 实现。
 */
export class DefaultAgentLoopService
  implements AgentLoopService
{
  /**
   * @param session - 会话服务。
   * @param contextManager - 模型上下文构建服务。
   * @param model - 模型服务。
   * @param tools - 工具服务。
   * @param events - Agent 事件服务。
   * @param permissions - 工具权限服务。
   * @param progress - 任务进度服务。
   * @param maxModelRounds - 最大模型请求轮次。
   * @param maxToolCalls - 最大工具调用数。
   * @param timeoutMs - 单次运行最大时间。
   */
  constructor(
    private readonly session: SessionService,
    private readonly contextManager: ContextManagerService,
    private readonly model: ModelService,
    private readonly tools: ToolsService,
    private readonly events: AgentEventService,
    private readonly permissions: PermissionService,
    private readonly progress: TaskProgressService | undefined,
    private readonly maxModelRounds: number,
    private readonly maxToolCalls: number,
    private readonly timeoutMs: number,
  ) {}

  /**
   * 执行一次 Agent 任务。
   *
   * @param input - 用户输入。
   * @param options - 当前运行的可选控制参数。
   * @returns Agent 最终回答。
   */
  async run(
    input: string,
    options: AgentRunOptions = {},
  ): Promise<string> {
    const budgetController = new AbortController()
    const signal = budgetController.signal
    const onParentAbort = (): void => {
      budgetController.abort(options.signal?.reason)
    }
    if (options.signal !== undefined) {
      options.signal.addEventListener('abort', onParentAbort, { once: true })
      if (options.signal.aborted) {
        onParentAbort()
      }
    }
    const timeout = setTimeout(() => {
      budgetController.abort(
        new AgentBudgetExceededError('timeout', this.timeoutMs),
      )
    }, this.timeoutMs)
    const runId = randomUUID()
    const taskId = options.taskId ?? runId
    const startedAt = Date.now()
    let terminalEventPublished = false
    let toolCallCount = 0
    let keepTaskGrant = false

    this.events.publish({
      type: 'agent-start',
      runId,
      timestamp: startedAt,
      inputLength: input.length,
    })

    const publishError = (error: unknown): void => {
      if (terminalEventPublished) {
        return
      }

      terminalEventPublished = true
      this.events.publish({
        type: 'agent-error',
        runId,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
        error: getErrorMessage(error),
      })
    }

    try {
      throwIfAborted(signal)

      if (options.taskSpecification !== undefined) {
        this.progress?.initialize(options.taskSpecification)
      }

      if (!options.resume) {
        this.session.append({
          role: 'user',
          content: input,
        })
      }

      for (
        let step = 0;
        step < this.maxModelRounds;
        step += 1
      ) {
        throwIfAborted(signal)

        const modelContext = await this.contextManager.build({
          systemPrompt: options.systemPrompt,
          taskSpecification: options.taskSpecification,
          taskProgress: options.taskSpecification === undefined
            ? undefined
            : this.progress?.current(),
        })
        const modelStartedAt = Date.now()

        this.events.publish({
          type: 'model-request-start',
          runId,
          timestamp: modelStartedAt,
          step,
          messageCount: modelContext.messages.length,
          toolCount: modelContext.tools.length,
        })

        const response = await this.model.complete({
          systemPrompt: modelContext.systemPrompt,
          messages: modelContext.messages,
          tools: modelContext.tools,
          signal,
          taskSpecification: modelContext.taskSpecification,
          taskProgress: modelContext.taskProgress,
        })

        throwIfAborted(signal)

        this.events.publish({
          type: 'model-response',
          runId,
          timestamp: Date.now(),
          step,
          kind: response.kind,
          toolCallCount:
            response.kind === 'tool-call'
              ? response.calls.length
              : 0,
          durationMs: Date.now() - modelStartedAt,
        })

        if (response.kind === 'final') {
          this.session.append({
            role: 'assistant',
            content: response.content,
          })
          this.session.flush()

          terminalEventPublished = true
          this.events.publish({
            type: 'agent-final',
            runId,
            timestamp: Date.now(),
            durationMs: Date.now() - startedAt,
            contentLength: response.content.length,
          })

          return response.content
        }

        if (response.calls.length === 0) {
          throw new Error(
            'model returned an empty tool-call list',
          )
        }

        if (toolCallCount + response.calls.length > this.maxToolCalls) {
          throw new AgentBudgetExceededError(
            'tool-calls',
            this.maxToolCalls,
          )
        }

        this.appendToolCallMessage(response.calls)

        for (const call of response.calls) {
          throwIfAborted(signal)
          toolCallCount += 1

          const toolStartedAt = Date.now()

          this.events.publish({
            type: 'tool-start',
            runId,
            timestamp: toolStartedAt,
            step,
            toolCallId: call.id,
            toolName: call.name,
          })

          let toolResult: string
          let toolError: string | undefined

          try {
            const permission = await this.permissions.authorize({
              runId,
              taskId,
              step,
              toolCallId: call.id,
              toolName: call.name,
              risk: this.tools.risk(call.name, call.arguments),
              arguments: structuredClone(call.arguments),
            }, signal)

            throwIfAborted(signal)

            if (permission !== 'allow') {
              throw new Error(`permission denied for tool "${call.name}"`)
            }

            toolResult = await this.tools.execute(
              call.name,
              call.arguments,
              signal,
            )

            throwIfAborted(signal)
          } catch (error: unknown) {
            if (signal?.aborted) {
              throw getAbortError(signal)
            }

            toolError = getErrorMessage(error)
            toolResult = `tool error: ${toolError}`
          }

          this.events.publish({
            type: 'tool-end',
            runId,
            timestamp: Date.now(),
            step,
            toolCallId: call.id,
            toolName: call.name,
            status: toolError === undefined ? 'success' : 'error',
            durationMs: Date.now() - toolStartedAt,
            resultLength: toolResult.length,
            ...(toolError === undefined
              ? {}
              : { error: toolError }),
          })

          this.session.append({
            role: 'tool',
            content: toolResult,
            toolCallId: call.id,
          })
        }
      }

      throw new AgentBudgetExceededError(
        'model-rounds',
        this.maxModelRounds,
      )
    } catch (error: unknown) {
      const finalError = signal?.aborted
        ? getAbortError(signal)
        : error

      keepTaskGrant = finalError instanceof AgentBudgetExceededError

      // 即使本次 run 失败，也尽量把已经产生的用户消息、工具调用和
      // 工具结果刷新到持久化后端，保证下次恢复时不会丢失中间过程。
      try {
        this.session.flush()
      } catch {
        // 原始 Agent 错误优先返回；同步 JSONL Provider 当前不会在此处失败。
      }
      publishError(finalError)
      throw finalError
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onParentAbort)
      this.permissions.releaseRun?.(runId)
      if (!keepTaskGrant) {
        this.permissions.releaseTask?.(taskId)
      }
    }
  }

  /**
   * 把模型工具调用写入 assistant 消息。
   *
   * @param calls - 模型生成的工具调用。
   */
  private appendToolCallMessage(
    calls: readonly ModelToolCall[],
  ): void {
    this.session.append({
      role: 'assistant',
      content: null,
      toolCalls: calls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: structuredClone(call.arguments),
      })),
    })
  }
}

/** 在 Agent Loop 的异步步骤之间传播取消。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw getAbortError(signal)
  }
}

/** 获取调用方设置的取消原因。 */
function getAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('agent run cancelled')
}

/**
 * 将未知错误转换为文本。
 *
 * @param error - 捕获到的错误。
 * @returns 错误消息。
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

/**
 * 创建 Agent Loop 插件。
 *
 * @param options - Agent Loop 配置。
 * @returns Agent Loop 插件。
 */
export function createAgentLoopPlugin(
  options: AgentLoopPluginOptions = {},
): MiniPlugin {
  const maxModelRounds =
    options.maxModelRounds ?? DEFAULT_MAX_MODEL_ROUNDS
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (!Number.isInteger(maxModelRounds) || maxModelRounds < 1) {
    throw new Error('maxModelRounds must be a positive integer')
  }
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1) {
    throw new Error('maxToolCalls must be a positive integer')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('timeoutMs must be a positive integer')
  }

  return {
    name: 'agent-loop',
    dependencies: [
      'session',
      'context-manager',
      'model',
      'tools',
      'agent-events',
      'permissions',
    ],

    setup(context) {
      const session = context.get<SessionService>('session')
      const contextManager = context.get<ContextManagerService>(
        'context-manager',
      )
      const model = context.get<ModelService>('model')
      const tools = context.get<ToolsService>('tools')
      const events = context.get<AgentEventService>(
        'agent-events',
      )
      const permissions = context.get<PermissionService>('permissions')
      const progress = context.has('task-progress')
        ? context.get<TaskProgressService>('task-progress')
        : undefined

      const agentLoop = new DefaultAgentLoopService(
        session,
        contextManager,
        model,
        tools,
        events,
        permissions,
        progress,
        maxModelRounds,
        maxToolCalls,
        timeoutMs,
      )

      return context.provide<AgentLoopService>(
        'agent-loop',
        agentLoop,
      )
    },
  }
}

/**
 * 默认 Agent Loop 插件。
 */
export const agentLoopPlugin = createAgentLoopPlugin()
