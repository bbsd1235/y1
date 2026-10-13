import type { TaskProgress } from './task-progress.js'
import type {
  TaskSpecification,
} from './task-specification.js'
import type { SessionMessage } from './session.js'
import type { ToolSchema } from './tools.js'

/**
 * 构建一次模型上下文时使用的动态信息。
 *
 * Session 消息和工具 Schema 由 Context Manager 从对应 Service 读取，
 * systemPrompt、任务规格和任务进度由当前 Agent Run 提供。
 */
export interface ContextBuildOptions {
  /** 当前 Agent Run 的系统指令。 */
  readonly systemPrompt?: string

  /** 取消当前上下文构建或历史摘要请求的信号。 */
  readonly signal?: AbortSignal

  /** 当前任务的结构化规格。 */
  readonly taskSpecification?: TaskSpecification

  /** 当前任务的执行进度。 */
  readonly taskProgress?: readonly TaskProgress[]
}

/**
 * Context Manager 对上下文窗口用量的估算结果。
 *
 * Token 数是本地粗略估算值，不承诺与模型服务端的 tokenizer 完全一致，
 * 主要用于自动压缩阈值和 CLI 展示。
 */
export interface ContextUsage {
  /** 当前上下文的估算 Token 数。 */
  readonly estimatedTokens: number

  /** 配置的上下文窗口上限。 */
  readonly maxTokens: number

  /** 估算用量占窗口上限的比例，范围为 0 到 1 以上。 */
  readonly usageRatio: number

  /** systemPrompt 的估算 Token 数。 */
  readonly systemPromptTokens: number

  /** 消息历史的估算 Token 数。 */
  readonly messageTokens: number

  /** 工具 Schema 的估算 Token 数。 */
  readonly toolTokens: number

  /** 任务规格和任务进度的估算 Token 数。 */
  readonly taskTokens: number

  /** 构建前 Session 中的完整消息数量。 */
  readonly originalMessageCount: number

  /** 实际放入本次模型上下文的消息数量。 */
  readonly includedMessageCount: number

  /** 本次上下文是否经过压缩或裁剪。 */
  readonly compacted: boolean
}

/**
 * Context Manager 生成的一次模型上下文快照。
 *
 * 这是 Session 历史的模型可见投影。Context Manager 可以裁剪或压缩
 * messages，但不修改 Session 中保存的完整历史。
 */
export interface ContextSnapshot {
  /** 当前模型请求使用的系统指令。 */
  readonly systemPrompt?: string

  /** 本次请求实际发送给模型的消息。 */
  readonly messages: readonly SessionMessage[]

  /** 本次请求实际发送给模型的工具描述。 */
  readonly tools: readonly ToolSchema[]

  /** 当前任务的结构化规格。 */
  readonly taskSpecification?: TaskSpecification

  /** 当前任务的执行进度。 */
  readonly taskProgress?: readonly TaskProgress[]

  /** 本次上下文的估算用量。 */
  readonly usage: ContextUsage
}

/**
 * 上下文管理服务。
 *
 * Service 只负责从完整 Session 历史构建模型上下文，并提供当前快照和
 * 手动压缩入口；它不执行工具，也不负责修改 Session 历史。
 */
export interface ContextManagerService {
  /**
   * 构建一次模型上下文。
   *
   * 方法读取完整 Session、工具 Schema，并根据上下文使用量决定是否
   * 自动生成历史摘要和裁剪工具结果。
   *
   * @param options - 当前 Agent Run 的动态上下文信息。
   * @returns 可直接交给 ModelService 的上下文快照。
   */
  build(options?: ContextBuildOptions): Promise<ContextSnapshot>

  /**
   * 返回最近一次构建或压缩产生的上下文快照。
   *
   * @returns 最近的上下文快照；尚未构建时返回 undefined。
   */
  current(): ContextSnapshot | undefined

  /**
   * 手动触发一次上下文压缩。
   *
   * 压缩只影响后续模型请求使用的投影，不删除或修改 Session 历史。
   *
   * @param options - 当前 Agent Run 的动态上下文信息。
   * @returns 压缩后的上下文快照。
   */
  compact(options?: ContextBuildOptions): Promise<ContextSnapshot>
}
