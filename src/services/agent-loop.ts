import type { TaskSpecification } from './task-specification.js'

/**
 * Agent Run 的控制参数。
 */
export interface AgentRunOptions {
  /** 取消当前运行时使用的信号。 */
  readonly signal?: AbortSignal

  /** 当前 Working Agent 使用的系统指令。 */
  readonly systemPrompt?: string

  /** 当前用户任务的稳定标识；继续 checkpoint 时必须复用。 */
  readonly taskId?: string

  /** Planning Agent 生成、供 Working Agent 执行的任务规格。 */
  readonly taskSpecification?: TaskSpecification

  /** 继续执行上一次因预算耗尽而暂停的任务，不追加新的用户消息。 */
  readonly resume?: boolean
}

/** Agent 因执行预算耗尽而保存 checkpoint。 */
export class AgentBudgetExceededError extends Error {
  /** 触发限制的预算类型。 */
  readonly reason: 'model-rounds' | 'tool-calls' | 'timeout'
  /** 配置的限制值。 */
  readonly limit: number

  /**
   * @param reason - 耗尽的预算类型。
   * @param limit - 配置的限制值。
   */
  constructor(
    reason: 'model-rounds' | 'tool-calls' | 'timeout',
    limit: number,
  ) {
    super(
      reason === 'timeout'
        ? `agent run exceeded timeout (${limit}ms)`
        : `agent run exceeded ${reason} budget (${limit})`,
    )
    this.name = 'AgentBudgetExceededError'
    this.reason = reason
    this.limit = limit
  }
}

/**
 * Agent Loop 服务。
 *
 * Agent Loop 负责协调：
 *
 * - SessionService：保存对话历史；
 * - ModelService：请求模型；
 * - ToolsService：执行模型请求的工具。
 *
 * Agent Loop 不关心这些服务的具体实现。
 */
export interface AgentLoopService {
  /**
   * 执行一次 Agent 任务。
   *
   * @param input - 用户输入。
   * @param options - 当前运行的可选控制参数。
   * @returns Agent 的最终文本回答。
   */
  run(input: string, options?: AgentRunOptions): Promise<string>
}
