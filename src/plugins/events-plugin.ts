import type { MiniPlugin } from '../plugin.js'
import type {
  AgentEvent,
  AgentEventListener,
  AgentEventService,
} from '../services/events.js'

/**
 * 内存 Agent 事件服务。
 *
 * 这是实时事件总线，不负责持久化。监听器异常会被隔离，避免
 * CLI 或日志观察者的 bug 破坏 Agent 主流程。
 */
export class InMemoryAgentEventService
  implements AgentEventService
{
  /** 当前订阅者。 */
  private readonly listeners = new Set<AgentEventListener>()

  /** 是否已经被所属 Context 销毁。 */
  private disposed = false

  /**
   * 发布事件。
   *
   * 使用订阅者快照，允许监听器在回调中取消订阅。
   *
   * @param event - 要发布的事件。
   */
  publish(event: AgentEvent): void {
    if (this.disposed) {
      return
    }

    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // 观察者失败不能改变 Agent 的执行结果。
      }
    }
  }

  /**
   * 订阅事件。
   *
   * @param listener - 事件监听器。
   * @returns 幂等 disposer。
   */
  subscribe(listener: AgentEventListener): () => void {
    if (this.disposed) {
      return () => {}
    }

    this.listeners.add(listener)
    let disposed = false

    return () => {
      if (disposed) {
        return
      }

      disposed = true
      this.listeners.delete(listener)
    }
  }

  /** 清理全部监听器。 */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }
}

/**
 * Agent 事件插件。
 *
 * 提供 agent-events Service，供 Agent Loop 和各种观察者消费。
 */
export const agentEventsPlugin: MiniPlugin = {
  name: 'agent-events',

  setup(context) {
    const events = new InMemoryAgentEventService()
    const removeService = context.provide(
      'agent-events',
      events,
    )

    return () => {
      events.dispose()
      removeService()
    }
  },
}
