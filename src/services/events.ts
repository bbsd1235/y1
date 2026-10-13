/**
 * Agent 事件的共同字段。
 */
export interface AgentEventBase {
  /** 事件类型。 */
  readonly type: string

  /** 一次 run 的唯一标识。 */
  readonly runId: string

  /** 事件产生时间，Unix milliseconds。 */
  readonly timestamp: number
}

/**
 * Agent 执行过程中的结构化事件。
 *
 * 事件只保存观测所需的摘要，不默认保存完整 Prompt、模型内容
 * 或工具结果，避免日志意外暴露代码和敏感信息。
 */
export type AgentEvent =
  | (AgentEventBase & {
      readonly type: 'agent-start'
      readonly inputLength: number
    })
  | (AgentEventBase & {
      readonly type: 'model-request-start'
      readonly step: number
      readonly messageCount: number
      readonly toolCount: number
    })
  | (AgentEventBase & {
      readonly type: 'model-response'
      readonly step: number
      readonly kind: 'final' | 'tool-call'
      readonly toolCallCount: number
      readonly durationMs: number
    })
  | (AgentEventBase & {
      readonly type: 'tool-start'
      readonly step: number
      readonly toolCallId: string
      readonly toolName: string
    })
  | (AgentEventBase & {
      readonly type: 'tool-end'
      readonly step: number
      readonly toolCallId: string
      readonly toolName: string
      readonly status: 'success' | 'error'
      readonly durationMs: number
      readonly resultLength: number
      readonly error?: string
    })
  | (AgentEventBase & {
      readonly type: 'agent-final'
      readonly durationMs: number
      readonly contentLength: number
    })
  | (AgentEventBase & {
      readonly type: 'agent-error'
      readonly durationMs: number
      readonly error: string
    })

/**
 * Agent 事件监听器。
 *
 * 监听器用于 CLI、日志、指标和测试等观察者，不应该改变 Agent
 * 的主控制流。
 */
export type AgentEventListener = (event: AgentEvent) => void

/**
 * Agent 事件服务。
 */
export interface AgentEventService {
  /**
   * 发布一个运行时事件。
   *
   * @param event - 要发布的事件。
   */
  publish(event: AgentEvent): void

  /**
   * 订阅事件。
   *
   * @param listener - 事件监听器。
   * @returns 移除该监听器的 disposer。
   */
  subscribe(listener: AgentEventListener): () => void
}
