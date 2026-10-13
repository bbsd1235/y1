import type { SessionMessage } from './session.js'
import type { TaskProgress } from './task-progress.js'
import type { TaskSpecification } from './task-specification.js'

/** 当前磁盘日志格式版本。格式变化时递增该值。 */
export const SESSION_FORMAT_VERSION = 3

/** 会话文件的元数据。元数据只写入文件第一行。 */
export interface SessionMetadata {
  readonly version: number
  readonly sessionId: string
  readonly cwd: string
  readonly createdAt: number
}

/** 一个已经持久化的会话摘要。 */
export interface SessionSummary extends SessionMetadata {
  readonly messageCount: number

  /** 当前会话中第一条用户输入，用于 CLI 展示会话摘要。 */
  readonly firstUserInput?: string
}

/** JSONL 文件中的第一行。 */
export interface SessionHeaderRecord {
  readonly type: 'session'
  readonly version: number
  readonly sessionId: string
  readonly cwd: string
  readonly createdAt: number
}

/** JSONL 文件中的消息行。 */
export interface SessionMessageRecord {
  readonly type: 'message'
  readonly sequence: number
  readonly timestamp: number
  readonly message: SessionMessage
}

/** JSONL 文件中的任务规格记录。 */
export interface SessionTaskSpecificationRecord {
  readonly type: 'task-specification'
  readonly timestamp: number
  readonly specification: TaskSpecification
}

/** JSONL 文件中的任务进度记录。 */
export interface SessionTaskProgressRecord {
  readonly type: 'task-progress'
  readonly timestamp: number
  readonly progress: TaskProgress
}

/** JSONL 文件的一行记录。 */
export type SessionRecord =
  | SessionHeaderRecord
  | SessionMessageRecord
  | SessionTaskSpecificationRecord
  | SessionTaskProgressRecord

/**
 * 会话持久化能力。
 *
 * Agent Loop 只依赖这个抽象，不知道记录最终存储在 JSONL、SQLite
 * 还是远程服务中。当前实现采用同步 API，以保持 mini-dsh 的插件
 * 初始化和 SessionService API 简单可读。
 */
export interface SessionPersistenceService {
  /** 持久化根目录。 */
  readonly rootDir: string

  /** 当前绑定的会话 id。 */
  readonly sessionId: string

  /** 当前会话元数据。 */
  readonly metadata: SessionMetadata

  /** 将一条消息追加到当前会话。 */
  append(message: SessionMessage): void

  /** 将当前任务规格追加到会话日志。 */
  saveTaskSpecification(specification: TaskSpecification): void

  /** 返回最近一次持久化的任务规格。 */
  taskSpecification(): TaskSpecification | undefined

  /** 读取每个任务最近一次的进度。 */
  taskProgress(): readonly TaskProgress[]

  /** 追加一条任务进度记录。 */
  saveTaskProgress(progress: TaskProgress): void

  /** 读取当前会话的完整消息历史。 */
  messages(): readonly SessionMessage[]

  /** 当前实现写入是同步的，该方法用于统一未来异步 Provider 的扩展点。 */
  flush(): void

  /** 当前会话是否已有磁盘文件。 */
  exists(): boolean

  /** 列出持久化根目录中的所有会话。 */
  list(): readonly SessionSummary[]

  /** 删除指定会话的持久化记录；目标不存在时返回 false。 */
  delete(sessionId: string): boolean
}
