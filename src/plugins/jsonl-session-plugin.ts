import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import type { MiniPlugin } from '../plugin.js'
import {
  SESSION_FORMAT_VERSION,
  type SessionHeaderRecord,
  type SessionMessageRecord,
  type SessionMetadata,
  type SessionPersistenceService,
  type SessionRecord,
  type SessionSummary,
} from '../services/session-persistence.js'
import type { TaskSpecification } from '../services/task-specification.js'
import { validateTaskSpecification } from '../services/task-specification.js'
import {
  validateTaskProgress,
  type TaskProgress,
} from '../services/task-progress.js'
import {
  snapshotSessionMessage,
  type SessionMessage,
  type SessionService,
} from '../services/session.js'

/** 当前实现仍可读取的历史 JSONL 格式版本。 */
const SUPPORTED_SESSION_FORMAT_VERSIONS = new Set([
  1,
  2,
  SESSION_FORMAT_VERSION,
])

/** JSONL Session 插件配置。 */
export interface JsonlSessionPluginOptions {
  /** JSONL 会话文件所在目录。 */
  readonly rootDir: string
  /** 要打开的会话 id。 */
  readonly sessionId: string
  /** 新会话使用的工作目录元数据。 */
  readonly cwd: string
}

/**
 * 基于 append-only JSONL 文件的 Session Provider。
 *
 * 文件第一行是 header，后续每行是一条消息记录。每次追加只写一行，
 * 因此不会因为新消息而重写整个历史文件。
 */
export class JsonlSessionService
  implements SessionService, SessionPersistenceService
{
  readonly rootDir: string
  readonly sessionId: string
  readonly metadata: SessionMetadata

  private readonly filePath: string
  private readonly history: SessionMessage[]
  private currentSpecification: TaskSpecification | undefined
  private readonly progress: Map<string, TaskProgress>
  private materialized: boolean

  /**
   * 打开新会话或恢复已有会话。
   *
   * @param options - JSONL Provider 配置。
   */
  constructor(options: JsonlSessionPluginOptions) {
    assertNonEmpty(options.sessionId, 'sessionId')
    assertNonEmpty(options.cwd, 'cwd')

    this.rootDir = resolve(options.rootDir)
    this.sessionId = options.sessionId
    this.filePath = join(this.rootDir, `${encodeSessionId(options.sessionId)}.jsonl`)

    if (existsSync(this.filePath)) {
      const loaded = readAndValidateFile(this.filePath, options.sessionId)
      this.metadata = loaded.metadata
      this.history = loaded.messages
      this.currentSpecification = loaded.specification
      this.progress = new Map(loaded.progress.map((item) => [item.taskId, item]))
      this.materialized = true
      return
    }

    this.metadata = {
      version: SESSION_FORMAT_VERSION,
      sessionId: options.sessionId,
      cwd: options.cwd,
      createdAt: Date.now(),
    }
    this.history = []
    this.currentSpecification = undefined
    this.progress = new Map()
    this.materialized = false
  }

  /** 追加一条消息，只有文件写入成功后才更新内存历史。 */
  append(message: SessionMessage): void {
    const snapshot = snapshotSessionMessage(message)
    const record: SessionMessageRecord = {
      type: 'message',
      sequence: this.history.length + 1,
      timestamp: Date.now(),
      message: snapshot,
    }

    mkdirSync(this.rootDir, { recursive: true })
    const line = `${JSON.stringify(record)}\n`

    if (!this.materialized) {
      // Header和第一条消息必须在同一次同步写入中落盘，避免出现空会话文件。
      writeDurably(
        this.filePath,
        `${JSON.stringify(toHeaderRecord(this.metadata))}\n${line}`,
        'wx',
      )
      this.materialized = true
    } else {
      writeDurably(this.filePath, line, 'a')
    }

    this.history.push(snapshot)
  }

  /** 追加并持久化最新任务规格。 */
  saveTaskSpecification(specification: TaskSpecification): void {
    const snapshot = validateTaskSpecification(specification)
    mkdirSync(this.rootDir, { recursive: true })
    const record = {
      type: 'task-specification' as const,
      timestamp: Date.now(),
      specification: snapshot,
    }
    const line = `${JSON.stringify(record)}\n`

    if (!this.materialized) {
      writeDurably(
        this.filePath,
        `${JSON.stringify(toHeaderRecord(this.metadata))}\n${line}`,
        'wx',
      )
      this.materialized = true
    } else {
      writeDurably(this.filePath, line, 'a')
    }

    this.currentSpecification = snapshot
  }

  /** 返回最近一次任务规格的副本。 */
  taskSpecification(): TaskSpecification | undefined {
    return this.currentSpecification === undefined
      ? undefined
      : validateTaskSpecification(this.currentSpecification)
  }

  /** 返回每个任务最近一次进度的副本。 */
  taskProgress(): readonly TaskProgress[] {
    return [...this.progress.values()].map(validateTaskProgress)
  }

  /** 追加并持久化一条任务进度。 */
  saveTaskProgress(progress: TaskProgress): void {
    const snapshot = validateTaskProgress(progress)
    mkdirSync(this.rootDir, { recursive: true })
    const record = {
      type: 'task-progress' as const,
      timestamp: Date.now(),
      progress: snapshot,
    }
    const line = `${JSON.stringify(record)}\n`

    if (!this.materialized) {
      writeDurably(
        this.filePath,
        `${JSON.stringify(toHeaderRecord(this.metadata))}\n${line}`,
        'wx',
      )
      this.materialized = true
    } else {
      writeDurably(this.filePath, line, 'a')
    }

    this.progress.set(snapshot.taskId, snapshot)
  }

  /** 返回深拷贝，避免调用方修改 Provider 内部历史。 */
  messages(): readonly SessionMessage[] {
    return this.history.map(snapshotSessionMessage)
  }

  /** 当前同步文件 Provider 无额外缓冲。 */
  flush(): void {}

  /** 判断当前会话是否已经物化为文件。 */
  exists(): boolean {
    return this.materialized
  }

  /** 扫描并校验所有 JSONL 会话文件的 header 和消息数量。 */
  list(): readonly SessionSummary[] {
    if (!existsSync(this.rootDir)) return []

    const summaries: SessionSummary[] = []
    for (const filename of readdirSync(this.rootDir)) {
      if (!filename.endsWith('.jsonl')) continue
      const path = join(this.rootDir, filename)
      const loaded = readAndValidateFile(path)
      const firstUserInput = loaded.messages.find(
        (message) => message.role === 'user',
      )?.content
      summaries.push({
        ...loaded.metadata,
        messageCount: loaded.messages.length,
        ...(firstUserInput === undefined ? {} : { firstUserInput }),
      })
    }
    return summaries.sort((left, right) => left.createdAt - right.createdAt)
  }

  /** 删除指定会话对应的 JSONL 文件。 */
  delete(sessionId: string): boolean {
    assertNonEmpty(sessionId, 'sessionId')
    const path = join(
      this.rootDir,
      `${encodeSessionId(sessionId)}.jsonl`,
    )

    try {
      unlinkSync(path)
      return true
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return false
      }
      throw new Error(
        `cannot delete session "${sessionId}": ${getErrorMessage(error)}`,
      )
    }
  }
}

/** 创建 JSONL Session 插件。 */
export function createJsonlSessionPlugin(
  options: JsonlSessionPluginOptions,
): MiniPlugin {
  return {
    name: 'session-jsonl',

    setup(context) {
      const session = new JsonlSessionService(options)
      const removeSession = context.provide<SessionService>('session', session)
      const removePersistence = context.provide<SessionPersistenceService>(
        'session-persistence',
        session,
      )

      return () => {
        session.flush()
        removePersistence()
        removeSession()
      }
    },
  }
}

/** 将元数据转换为 header 行。 */
function toHeaderRecord(metadata: SessionMetadata): SessionHeaderRecord {
  return { type: 'session', ...metadata }
}

/** 读取并严格校验一个 JSONL 文件。 */
function readAndValidateFile(
  path: string,
  expectedSessionId?: string,
): {
  readonly metadata: SessionMetadata
  readonly messages: SessionMessage[]
  readonly specification?: TaskSpecification
  readonly progress: readonly TaskProgress[]
} {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    throw new Error(`cannot read session file "${path}": ${getErrorMessage(error)}`)
  }

  // 最后一行没有换行符时，可能是进程在写入过程中崩溃留下的半行。
  // 只有无法解析的最后半行会被截断，已经以换行符提交的坏记录仍然报错。
  if (!content.endsWith('\n')) {
    const lastNewline = content.lastIndexOf('\n')
    const tail = content.slice(lastNewline + 1)
    if (lastNewline >= 0) {
      try {
        JSON.parse(tail)
      } catch {
        const committed = content.slice(0, lastNewline + 1)
        truncateSync(path, Buffer.byteLength(committed, 'utf8'))
        content = committed
      }
    }
  }

  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()

  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) throw new Error(`invalid session file "${path}": missing header`)

  const header = parseJson(lines[0] as string, path, 1)
  validateHeader(header, expectedSessionId, path)
  const metadata: SessionMetadata = {
    version: header.version,
    sessionId: header.sessionId,
    cwd: header.cwd,
    createdAt: header.createdAt,
  }

  const messages: SessionMessage[] = []
  let specification: TaskSpecification | undefined
  const progress = new Map<string, TaskProgress>()
  const toolCallIds = new Set<string>()
  for (let index = 1; index < lines.length; index += 1) {
    const record = parseJson(lines[index] as string, path, index + 1)
    if (record.type === 'task-specification') {
      validateTaskSpecificationRecord(record, metadata.sessionId, path)
      specification = validateTaskSpecification(record.specification)
      continue
    }

    if (record.type === 'task-progress') {
      validateTaskProgressRecord(record, metadata.sessionId, path)
      const snapshot = validateTaskProgress(record.progress)
      progress.set(snapshot.taskId, snapshot)
      continue
    }

    validateMessageRecord(
      record,
      messages.length + 1,
      metadata.sessionId,
      toolCallIds,
      path,
    )
    messages.push(snapshotSessionMessage(record.message))
  }

  return {
    metadata,
    messages,
    progress: [...progress.values()],
    ...(specification === undefined ? {} : { specification }),
  }
}

/** 校验任务规格记录。 */
function validateTaskSpecificationRecord(
  value: Record<string, unknown>,
  sessionId: string,
  path: string,
): asserts value is Record<string, unknown> & {
  readonly type: 'task-specification'
  readonly timestamp: number
  readonly specification: unknown
} {
  if (value.type !== 'task-specification') {
    throw new Error(`invalid session "${sessionId}" in "${path}": unsupported record type`)
  }
  assertNonNegativeSafeInteger(value.timestamp, 'timestamp', path)
  try {
    validateTaskSpecification(value.specification)
  } catch (error: unknown) {
    throw new Error(`invalid task specification in session "${sessionId}": ${getErrorMessage(error)}`)
  }
}

/** 校验任务进度记录。 */
function validateTaskProgressRecord(
  value: Record<string, unknown>,
  sessionId: string,
  path: string,
): asserts value is Record<string, unknown> & {
  readonly type: 'task-progress'
  readonly timestamp: number
  readonly progress: unknown
} {
  if (value.type !== 'task-progress') {
    throw new Error(`invalid session "${sessionId}" in "${path}": unsupported record type`)
  }
  assertNonNegativeSafeInteger(value.timestamp, 'timestamp', path)
  try {
    validateTaskProgress(value.progress)
  } catch (error: unknown) {
    throw new Error(`invalid task progress in session "${sessionId}": ${getErrorMessage(error)}`)
  }
}

/** 解析 JSON 行并统一补充文件位置。 */
function parseJson(line: string, path: string, lineNumber: number): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(line)
    if (!isRecord(value)) throw new Error('record must be an object')
    return value
  } catch (error: unknown) {
    throw new Error(`invalid JSON record in session file "${path}" at line ${lineNumber}: ${getErrorMessage(error)}`)
  }
}

/** 校验 header。 */
function validateHeader(
  value: Record<string, unknown>,
  expectedSessionId: string | undefined,
  path: string,
): asserts value is Record<string, unknown> & SessionHeaderRecord {
  if (value.type !== 'session') throw new Error(`invalid session file "${path}": first record must be a session header`)
  if (!SUPPORTED_SESSION_FORMAT_VERSIONS.has(value.version as number)) throw new Error(`unsupported session format version ${String(value.version)} in "${path}"`)
  assertString(value.sessionId, 'sessionId', path)
  if (expectedSessionId !== undefined && value.sessionId !== expectedSessionId) {
    throw new Error(`session id mismatch in "${path}": expected "${expectedSessionId}"`)
  }
  assertString(value.cwd, 'cwd', path)
  assertNonNegativeSafeInteger(value.createdAt, 'createdAt', path)
}

/** 校验消息记录、序号和工具调用配对关系。 */
function validateMessageRecord(
  value: Record<string, unknown>,
  expectedSequence: number,
  sessionId: string,
  toolCallIds: Set<string>,
  path: string,
): asserts value is Record<string, unknown> & SessionMessageRecord {
  if (value.type !== 'message') throw new Error(`invalid session "${sessionId}" in "${path}": record must be a message record`)
  if (value.sequence !== expectedSequence) throw new Error(`invalid session "${sessionId}" in "${path}": expected sequence ${expectedSequence}, got ${String(value.sequence)}`)
  assertNonNegativeSafeInteger(value.timestamp, 'timestamp', path)
  const message = snapshotSessionMessage(value.message)

  if (message.role === 'assistant' && message.content === null) {
    for (const call of message.toolCalls) toolCallIds.add(call.id)
  }
  if (message.role === 'tool') {
    if (!toolCallIds.has(message.toolCallId)) {
      throw new Error(`invalid session "${sessionId}" in "${path}": tool result references unknown call "${message.toolCallId}"`)
    }
  }
}

/** 判断普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验字符串字段。 */
function assertString(value: unknown, field: string, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid session file "${path}": ${field} must be a non-empty string`)
}

/** 校验非负安全整数。 */
function assertNonNegativeSafeInteger(value: unknown, field: string, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`invalid session file "${path}": ${field} must be a non-negative safe integer`)
}

/** 校验运行时配置字符串。 */
function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} must not be empty`)
}

/** 将 session id 编码成安全的单个文件名片段。 */
function encodeSessionId(sessionId: string): string {
  return Buffer.from(sessionId, 'utf8').toString('base64url')
}

/** 追加一段 UTF-8 文本并同步刷新文件描述符。 */
function writeDurably(
  path: string,
  content: string,
  flags: 'a' | 'wx',
): void {
  const fd = openSync(path, flags)
  try {
    writeSync(fd, content, undefined, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** 将未知错误转换成文本。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 判断 Node.js 文件系统错误。 */
function isNodeError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
