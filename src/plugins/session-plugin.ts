import type { MiniPlugin } from '../plugin.js'
import type { JsonlSessionPluginOptions } from './jsonl-session-plugin.js'
import { createJsonlSessionPlugin } from './jsonl-session-plugin.js'
import type {
  SessionMessage,
  SessionService,
  SessionToolCall,
} from '../services/session.js'

/**
 * 内存 Session Service。
 */
export class InMemorySessionService implements SessionService {
  /**
   * 会话消息历史。
   */
  private readonly history: SessionMessage[] = []

  /**
   * 追加消息。
   *
   * @param message - 要保存的消息。
   */
  append(message: SessionMessage): void {
    this.history.push(cloneMessage(message))
  }

  /**
   * 返回消息副本。
   *
   * @returns 当前会话历史。
   */
  messages(): readonly SessionMessage[] {
    return this.history.map(cloneMessage)
  }

  /** 内存 Session 没有需要写入的后端。 */
  flush(): void {}
}

/**
 * 深拷贝一条 Session 消息。
 *
 * 工具参数可能包含嵌套对象，因此使用 structuredClone
 * 避免外部修改内部会话数据。
 *
 * @param message - 要复制的消息。
 * @returns 消息副本。
 */
function cloneMessage(message: SessionMessage): SessionMessage {
  if (message.role === 'user') {
    return {
      role: 'user',
      content: message.content,
    }
  }

  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      toolCallId: message.toolCallId,
    }
  }

  if (message.content !== null) {
    return {
      role: 'assistant',
      content: message.content,
    }
  }

  return {
    role: 'assistant',
    content: null,
    toolCalls: message.toolCalls.map(cloneToolCall),
  }
}

/**
 * 复制一次工具调用。
 *
 * @param call - 工具调用。
 * @returns 工具调用副本。
 */
function cloneToolCall(
  call: SessionToolCall,
): SessionToolCall {
  return {
    id: call.id,
    name: call.name,
    arguments: structuredClone(call.arguments),
  }
}

/**
 * 内存 Session 插件。
 */
export const sessionPlugin: MiniPlugin = {
  name: 'session',

  setup(context) {
    const session = new InMemorySessionService()

    return context.provide('session', session)
  },
}

/**
 * 根据配置选择内存 Session 或 JSONL Session。
 *
 * JSONL Provider 使用独立插件名，便于和默认内存插件二选一装配。
 * Runtime 会在选择持久化模式时只加载 JSONL 插件。
 *
 * @param options - JSONL 会话配置；不传时返回内存插件。
 * @returns 一个 Session Provider 插件。
 */
export function createSessionPlugin(
  options?: JsonlSessionPluginOptions,
): MiniPlugin {
  if (options === undefined) return sessionPlugin

  const jsonlPlugin = createJsonlSessionPlugin(options)
  return {
    ...jsonlPlugin,
    // JSONL 插件需要占用和内存插件相同的 service key，但插件名必须
    // 与默认插件不同，否则 Runtime 无法清晰表达 Provider 的选择。
    name: 'session-jsonl',
  }
}
