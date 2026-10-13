/**
 * 工具参数对象。
 *
 * 当前把参数限制为 JSON 对象。
 * 后续可以增加更严格的 JSON Schema 类型。
 */
export type ToolArguments = Record<string, unknown>

/**
 * 工具执行风险。
 *
 * 该字段只供运行时权限层使用，不会暴露给模型。`read-only` 工具可以
 * 自动执行，其他风险级别默认需要获得用户授权。
 */
export type ToolRisk =
  | 'read-only'
  | 'agent-state'
  | 'workspace-write'
  | 'shell'
  | 'shell-low'
  | 'shell-high'

/**
 * 模型可见的工具描述。
 *
 * 这个结构会被传给 ModelService。
 *
 * 注意：
 *
 * execute() 不属于 ToolSchema。
 * 工具实现细节不能直接暴露给模型。
 */
export interface ToolSchema {
  /**
   * 工具名称。
   */
  readonly name: string

  /**
   * 工具用途描述。
   */
  readonly description: string

  /**
   * 工具参数的 JSON Schema-like 描述。
   */
  readonly parameters: Record<string, unknown>
}

/**
 * 完整工具定义。
 *
 * ToolDefinition 包含：
 *
 * - 模型可见的 schema；
 * - 运行时执行函数。
 */
export interface ToolDefinition extends ToolSchema {
  /** 工具的副作用等级。 */
  readonly risk: ToolRisk

  /** 可根据参数细分风险，例如区分低风险和高风险 Shell 命令。 */
  readonly riskFor?: (args: ToolArguments) => ToolRisk
  /**
   * 执行工具。
   *
   * 使用 Promise 是因为未来的工具可能执行：
   *
   * - 文件读取；
   * - 文件写入；
   * - Shell 命令；
   * - HTTP 请求；
   * - 子进程操作。
   *
   * @param args - 模型传入的工具参数。
   * @param signal - 取消当前工具执行的信号。
   * @returns 工具执行结果文本。
   */
  execute(args: ToolArguments, signal?: AbortSignal): Promise<string>
}

/**
 * 工具服务。
 *
 * ToolsService 负责：
 *
 * - 注册工具；
 * - 移除工具；
 * - 提供模型可见的工具 schema；
 * - 根据名称执行工具。
 */
export interface ToolsService {
  /**
   * 注册一个工具。
   *
   * @param definition - 工具定义。
   * @returns 移除该工具的 disposer。
   */
  register(definition: ToolDefinition): () => void

  /**
   * 返回模型可见的工具 schema。
   *
   * 这里返回 ToolSchema，而不是 ToolDefinition。
   * 因为模型不应该看到 execute() 函数。
   *
   * @returns 当前已注册工具的 schema。
   */
  schemas(): readonly ToolSchema[]

  /**
   * 获取一个工具的运行时风险级别。
   *
   * @param name - 工具名称。
   * @returns 工具风险级别。
   */
  risk(name: string, args?: ToolArguments): ToolRisk

  /**
   * 执行指定工具。
   *
   * @param name - 工具名称。
   * @param args - 工具参数。
   * @param signal - 取消当前工具执行的信号。
   * @returns 工具执行结果文本。
   */
  execute(
    name: string,
    args: ToolArguments,
    signal?: AbortSignal,
  ): Promise<string>
}
