import type {
  SessionMessage,
  SessionToolCall,
} from './session.js'
import type { ToolSchema } from './tools.js'
import type { TaskProgress } from './task-progress.js'
import type { TaskSpecification } from './task-specification.js'

/**
 * 一次模型请求。
 */
export interface ModelRequest {
  /**
   * 只对本次模型请求生效的系统指令。
   *
   * 调用方使用该字段提供本次模型请求的系统指令，避免把它伪装成
   * 普通用户消息。
   */
  readonly systemPrompt?: string

  /**
   * 当前会话历史。
   */
  readonly messages: readonly SessionMessage[]

  /**
   * 模型可以使用的工具 schema。
   */
  readonly tools: readonly ToolSchema[]

  /** Planning Agent 为当前 Worker 生成的任务规格。 */
  readonly taskSpecification?: TaskSpecification

  /** 当前 Worker 的任务进度。 */
  readonly taskProgress?: readonly TaskProgress[]

  /** 取消当前模型请求的信号。 */
  readonly signal?: AbortSignal
}

/**
 * 模型生成的一次工具调用。
 *
 * 与 SessionToolCall 使用相同结构，保证模型响应
 * 可以直接写入 Session。
 */
export type ModelToolCall = SessionToolCall

/**
 * 模型响应。
 */
export type ModelResponse =
  | {
      /**
       * 模型已经生成最终答案。
       */
      readonly kind: 'final'

      /**
       * 最终文本。
       */
      readonly content: string
    }
  | {
      /**
       * 模型要求执行工具。
       */
      readonly kind: 'tool-call'

      /**
       * 本次响应中的工具调用列表。
       */
      readonly calls: readonly ModelToolCall[]
    }

/**
 * 模型服务。
 */
export interface ModelService {
  /**
   * 请求模型完成一个 step。
   *
   * @param request - 模型请求。
   * @returns 模型响应。
   */
  complete(request: ModelRequest): Promise<ModelResponse>
}
