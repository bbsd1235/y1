import type { ToolArguments } from './tools.js'

/**
 * 一次工具调用。
 *
 * 该结构同时用于：
 *
 * - Session 中记录 assistant 的工具调用；
 * - ModelService 表示模型生成的工具调用。
 */
export interface SessionToolCall {
  /**
   * 工具调用 id。
   */
  readonly id: string

  /**
   * 工具名称。
   */
  readonly name: string

  /**
   * 工具参数。
   */
  readonly arguments: ToolArguments
}

/**
 * 一条会话消息。
 *
 * assistant 消息有两种形式：
 *
 * - 普通文本回答；
 * - 工具调用消息。
 */
export type SessionMessage =
  | {
      readonly role: 'user'
      readonly content: string
    }
  | {
      readonly role: 'assistant'
      readonly content: string
      readonly toolCalls?: never
    }
  | {
      readonly role: 'assistant'
      readonly content: null
      readonly toolCalls: readonly SessionToolCall[]
    }
  | {
      readonly role: 'tool'
      readonly content: string
      readonly toolCallId: string
    }

/**
 * 会话服务。
 */
export interface SessionService {
  /**
   * 追加一条消息。
   *
   * @param message - 要追加的消息。
   */
  append(message: SessionMessage): void

  /**
   * 获取全部消息。
   *
   * @returns 当前会话的消息历史。
   */
  messages(): readonly SessionMessage[]

  /**
   * 将当前会话的待写数据刷新到持久化后端。
   *
   * 内存 Session 没有待写数据，因此实现可以是空操作。
   */
  flush(): void
}

/**
 * 复制并校验一条 Session 消息。
 *
 * 该函数用于持久化输入边界：除了保证消息满足 TypeScript 协议外，
 * 还会拒绝无法安全写入 JSON 的工具参数。
 *
 * @param value - 待复制的未知值。
 * @returns 深拷贝后的合法 Session 消息。
 */
export function snapshotSessionMessage(value: unknown): SessionMessage {
  if (!isRecord(value) || value.role !== 'user' && value.role !== 'assistant' && value.role !== 'tool') {
    throw new Error('invalid session message: role must be user, assistant, or tool')
  }

  if (value.role === 'user') {
    assertString(value.content, 'user message content')
    return { role: 'user', content: value.content }
  }

  if (value.role === 'tool') {
    assertString(value.content, 'tool result content')
    assertString(value.toolCallId, 'tool result toolCallId')
    return {
      role: 'tool',
      content: value.content,
      toolCallId: value.toolCallId,
    }
  }

  if (typeof value.content === 'string') {
    return { role: 'assistant', content: value.content }
  }

  if (value.content !== null || !Array.isArray(value.toolCalls)) {
    throw new Error('invalid assistant message: content must be string or null with toolCalls')
  }

  return {
    role: 'assistant',
    content: null,
    toolCalls: value.toolCalls.map((call, index) => snapshotToolCall(call, index)),
  }
}

/** 运行时使用的普通对象判定。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验字符串字段。 */
function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`invalid session message: ${field} must be a string`)
  }
}

/** 校验并复制工具调用。 */
function snapshotToolCall(value: unknown, index: number): SessionToolCall {
  if (!isRecord(value)) {
    throw new Error(`invalid tool call at index ${index}`)
  }

  assertString(value.id, `tool call ${index} id`)
  assertString(value.name, `tool call ${index} name`)

  if (!isRecord(value.arguments)) {
    throw new Error(`invalid tool call ${index} arguments: expected an object`)
  }

  return {
    id: value.id,
    name: value.name,
    arguments: cloneJsonObject(value.arguments),
  }
}

/**
 * 复制 JSON 对象并拒绝 undefined、循环引用、非有限数字和非普通对象。
 */
function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  const active = new Set<object>()

  const clone = (current: unknown): unknown => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return current
    }

    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new Error('invalid tool arguments: numbers must be finite')
      }
      return current
    }

    if (typeof current !== 'object') {
      throw new Error('invalid tool arguments: value is not JSON-serializable')
    }

    if (active.has(current)) {
      throw new Error('invalid tool arguments: circular reference')
    }
    active.add(current)

    let result: unknown
    if (Array.isArray(current)) {
      result = current.map(clone)
    } else {
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('invalid tool arguments: expected plain objects')
      }

      const object: Record<string, unknown> = {}
      const source = current as Record<string, unknown>
      for (const key of Object.keys(source)) {
        object[key] = clone(source[key])
      }
      result = object
    }

    active.delete(current)
    return result
  }

  return clone(value) as Record<string, unknown>
}
