import type { MiniPlugin } from '../plugin.js'
import type {
  ModelRequest,
  ModelResponse,
  ModelService,
  ModelToolCall,
} from '../services/model.js'
import type {
  SessionMessage,
} from '../services/session.js'
import type {
  ToolSchema,
} from '../services/tools.js'
import {
  createWorkingAgentSystemPrompt,
} from '../services/task-specification.js'

/**
 * DeepSeek 模型插件配置。
 */
export interface DeepSeekModelPluginOptions {
  /**
   * DeepSeek API Key。
   *
   * 不传时读取 DEEPSEEK_API_KEY。
   */
  readonly apiKey?: string

  /**
   * API 基础地址。
   *
   * 不传时读取 DEEPSEEK_BASE_URL，
   * 再没有则使用 DeepSeek 默认地址。
   */
  readonly baseUrl?: string

  /**
   * 模型名称。
   *
   * 默认使用 deepseek-v4-flash。
   */
  readonly model?: string

  /**
   * HTTP 请求函数。
   *
   * 主要用于测试时注入 mock fetch。
   */
  readonly fetcher?: typeof fetch
}

/**
 * DeepSeek 模型服务配置。
 */
export interface DeepSeekModelConfig {
  /**
   * API Key。
   */
  readonly apiKey: string

  /**
   * API 基础地址。
   */
  readonly baseUrl: string

  /**
   * 模型名称。
   */
  readonly model: string

  /**
   * HTTP 请求函数。
   */
  readonly fetcher?: typeof fetch
}

/**
 * DeepSeek API 默认地址。
 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/**
 * 默认模型名称。
 */
const DEFAULT_MODEL = 'deepseek-v4-flash'

/**
 * DeepSeek API 的工具描述。
 */
interface DeepSeekTool {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }
}

/**
 * DeepSeek API 的消息类型。
 */
type DeepSeekMessage =
  | {
      readonly role: 'system'
      readonly content: string
    }
  | {
      readonly role: 'user'
      readonly content: string
    }
  | {
      readonly role: 'assistant'
      readonly content: string
    }
  | {
      readonly role: 'assistant'
      readonly content: null
      readonly tool_calls: readonly {
        readonly id: string
        readonly type: 'function'
        readonly function: {
          readonly name: string
          readonly arguments: string
        }
      }[]
    }
  | {
      readonly role: 'tool'
      readonly content: string
      readonly tool_call_id: string
    }

/**
 * DeepSeek API 请求体。
 */
interface DeepSeekRequestBody {
  readonly model: string
  readonly messages: readonly DeepSeekMessage[]
  readonly tools?: readonly DeepSeekTool[]
  readonly tool_choice?: 'auto'
}

/**
 * DeepSeek 模型服务。
 *
 * 它负责：
 *
 * - 将 mini-dsh 消息转换成 DeepSeek API 消息；
 * - 将工具 schema 转换成 API 工具格式；
 * - 发送 HTTP 请求；
 * - 将 API 响应转换成 ModelResponse。
 */
export class DeepSeekModelService implements ModelService {
  /**
   * DeepSeek API 请求地址。
   */
  private readonly endpoint: string

  /**
   * HTTP 请求函数。
   */
  private readonly fetcher: typeof fetch

  /**
   * @param config - DeepSeek 模型配置。
   */
  constructor(config: DeepSeekModelConfig) {
    if (config.apiKey.trim().length === 0) {
      throw new Error('DeepSeek API key must not be empty')
    }

    if (config.model.trim().length === 0) {
      throw new Error('DeepSeek model must not be empty')
    }

    const baseUrl = config.baseUrl.replace(/\/+$/, '')

    this.endpoint = `${baseUrl}/chat/completions`
    this.fetcher = config.fetcher ?? fetch

    try {
      new URL(this.endpoint)
    } catch {
      throw new Error(
        `invalid DeepSeek base URL: ${config.baseUrl}`,
      )
    }

    this.apiKey = config.apiKey
    this.model = config.model
  }

  /**
   * API Key。
   */
  private readonly apiKey: string

  /**
   * 模型名称。
   */
  private readonly model: string

  /**
   * 请求 DeepSeek 模型。
   *
   * 当前版本使用非流式请求。
   *
   * @param request - mini-dsh 模型请求。
   * @returns mini-dsh 模型响应。
   */
  async complete(request: ModelRequest): Promise<ModelResponse> {
    throwIfAborted(request.signal)

    const requestBody = createRequestBody(
      this.model,
      request,
    )

    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: request.signal,
    })

    const responseText = await response.text()
    const payload = parseJson(responseText)

    throwIfAborted(request.signal)

    if (!response.ok) {
      throw new Error(
        `DeepSeek API request failed with status ` +
          `${response.status}: ${getApiErrorMessage(payload, responseText)}`,
      )
    }

    return parseModelResponse(payload)
  }
}

/** 在模型请求前后保持 Agent Run 的取消原因。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('agent run cancelled')
  }
}

/**
 * 将 mini-dsh 请求转换为 DeepSeek API 请求。
 *
 * @param model - 模型名称。
 * @param request - mini-dsh 请求。
 * @returns DeepSeek API 请求体。
 */
function createRequestBody(
  model: string,
  request: ModelRequest,
): DeepSeekRequestBody {
  const body: {
    model: string
    messages: readonly DeepSeekMessage[]
    tools?: readonly DeepSeekTool[]
    tool_choice?: 'auto'
  } = {
    model,
    messages: [
      ...(request.systemPrompt === undefined
        ? []
        : [{
            role: 'system' as const,
            content: request.systemPrompt,
          }]),
      ...(request.taskSpecification === undefined
        ? []
        : [{
            role: 'system' as const,
            content: createWorkingAgentSystemPrompt(
              request.taskSpecification,
              request.taskProgress,
            ),
          }]),
      ...request.messages.map(toDeepSeekMessage),
    ],
  }

  if (request.tools.length > 0) {
    body.tools = request.tools.map(toDeepSeekTool)
    body.tool_choice = 'auto'
  }

  return body
}

/**
 * 转换一条会话消息。
 *
 * @param message - mini-dsh 会话消息。
 * @returns DeepSeek API 消息。
 */
function toDeepSeekMessage(
  message: SessionMessage,
): DeepSeekMessage {
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
      tool_call_id: message.toolCallId,
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
    tool_calls: message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      },
    })),
  }
}

/**
 * 转换一个工具 schema。
 *
 * @param schema - mini-dsh 工具 schema。
 * @returns DeepSeek API 工具描述。
 */
function toDeepSeekTool(schema: ToolSchema): DeepSeekTool {
  return {
    type: 'function',
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
    },
  }
}

/**
 * 解析 DeepSeek 响应。
 *
 * @param payload - API 返回的未知 JSON 数据。
 * @returns mini-dsh 模型响应。
 */
function parseModelResponse(payload: unknown): ModelResponse {
  if (!isRecord(payload)) {
    throw new Error(
      'DeepSeek API returned an invalid response object',
    )
  }

  const choices = payload.choices

  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(
      'DeepSeek API response does not contain choices',
    )
  }

  const firstChoice = choices[0]

  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new Error(
      'DeepSeek API response does not contain a message',
    )
  }

  const message = firstChoice.message
  const rawToolCalls = message.tool_calls

  if (rawToolCalls !== undefined) {
    if (!Array.isArray(rawToolCalls)) {
      throw new Error(
        'DeepSeek API returned invalid tool_calls',
      )
    }

    if (rawToolCalls.length > 0) {
      return {
        kind: 'tool-call',
        calls: rawToolCalls.map(parseToolCall),
      }
    }
  }

  const content = message.content

  if (typeof content === 'string') {
    return {
      kind: 'final',
      content,
    }
  }

  if (content === null) {
    return {
      kind: 'final',
      content: '',
    }
  }

  throw new Error(
    'DeepSeek API response does not contain valid content',
  )
}

/**
 * 解析一个 DeepSeek 工具调用。
 *
 * @param value - API 返回的未知工具调用。
 * @returns mini-dsh 工具调用。
 */
function parseToolCall(value: unknown): ModelToolCall {
  if (!isRecord(value)) {
    throw new Error(
      'DeepSeek API returned an invalid tool call',
    )
  }

  const id = requireStringProperty(value, 'id')
  const functionValue = value.function

  if (!isRecord(functionValue)) {
    throw new Error(
      'DeepSeek API tool call does not contain function',
    )
  }

  const name = requireStringProperty(functionValue, 'name')
  const rawArguments = requireStringProperty(
    functionValue,
    'arguments',
  )

  let parsedArguments: unknown

  try {
    parsedArguments = JSON.parse(rawArguments)
  } catch {
    throw new Error(
      `DeepSeek tool "${name}" returned invalid JSON arguments`,
    )
  }

  if (!isRecord(parsedArguments)) {
    throw new Error(
      `DeepSeek tool "${name}" arguments must be an object`,
    )
  }

  return {
    id,
    name,
    arguments: parsedArguments,
  }
}

/**
 * 读取对象中的非空字符串属性。
 *
 * @param value - 未知对象。
 * @param name - 属性名称。
 * @returns 属性值。
 */
function requireStringProperty(
  value: Record<string, unknown>,
  name: string,
): string {
  const property = value[name]

  if (typeof property !== 'string' || property.length === 0) {
    throw new Error(
      `DeepSeek API property "${name}" must be a non-empty string`,
    )
  }

  return property
}

/**
 * 判断一个值是否为普通对象。
 *
 * @param value - 未知值。
 * @returns 如果是普通对象，则返回 true。
 */
function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

/**
 * 解析 JSON 响应。
 *
 * @param text - HTTP 响应文本。
 * @returns 解析后的未知值，解析失败时返回 undefined。
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(
        'DeepSeek API returned invalid JSON response',
    )
  }
}

/**
 * 获取 API 错误消息。
 *
 * @param payload - API JSON 响应。
 * @param responseText - 原始响应文本。
 * @returns 可读错误消息。
 */
function getApiErrorMessage(
  payload: unknown,
  responseText: string,
): string {
  if (isRecord(payload) && isRecord(payload.error)) {
    const message = payload.error.message

    if (typeof message === 'string') {
      return message
    }
  }

  const trimmedText = responseText.trim()

  return trimmedText.length > 0
    ? trimmedText
    : 'unknown API error'
}

/**
 * 创建 DeepSeek 模型插件。
 *
 * 该插件提供 "model" service。
 *
 * @param options - DeepSeek 模型配置。
 * @returns DeepSeek 模型插件。
 */
export function createDeepSeekModelPlugin(
  options: DeepSeekModelPluginOptions = {},
): MiniPlugin {
  return {
    name: 'deepseek-model',

    setup(context) {
      const apiKey =
        options.apiKey ?? process.env.DEEPSEEK_API_KEY

      if (apiKey === undefined || apiKey.trim().length === 0) {
        throw new Error(
          'DeepSeek API key is required; ' +
            'set DEEPSEEK_API_KEY or pass apiKey',
        )
      }

      const baseUrl =
        options.baseUrl ??
        process.env.DEEPSEEK_BASE_URL ??
        DEFAULT_BASE_URL

      const model = options.model ?? DEFAULT_MODEL

      const service = new DeepSeekModelService({
        apiKey,
        baseUrl,
        model,
        fetcher: options.fetcher,
      })

      return context.provide('model', service)
    },
  }
}

/**
 * 默认 DeepSeek 模型插件。
 *
 * API Key 在插件 setup 时读取，
 * 因此导入该模块本身不会立即要求环境变量。
 */
export const deepSeekModelPlugin =
  createDeepSeekModelPlugin()
