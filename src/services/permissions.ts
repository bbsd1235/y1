import type { ToolArguments, ToolRisk } from './tools.js'

/** 一次工具授权请求。 */
export interface PermissionRequest {
  /** Agent Loop 的一次运行标识。 */
  readonly runId: string
  /** 用户任务标识；同一任务的 /continue 会复用该值。 */
  readonly taskId?: string
  /** 当前模型请求的 step。 */
  readonly step: number
  /** 工具调用标识。 */
  readonly toolCallId: string
  /** 工具名称。 */
  readonly toolName: string
  /** 工具风险级别。 */
  readonly risk: ToolRisk
  /** 即将传给工具的参数。 */
  readonly arguments: ToolArguments
}

/** 用户或策略对工具调用作出的决定。 */
export type PermissionDecision = 'allow' | 'deny'

/** CLI 对高风险工具授予的授权范围；allow-run 表示当前任务。 */
export type PermissionApproval =
  | PermissionDecision
  | 'allow-once'
  | 'allow-run'
  | 'allow-session'
  | boolean

/** CLI 或其他交互层提供的授权询问函数。 */
export type ToolApprovalHandler = (
  request: PermissionRequest,
  signal?: AbortSignal,
) => PermissionApproval | Promise<PermissionApproval>

/** 工具权限服务。 */
export interface PermissionService {
  /**
   * 判断一次工具调用是否可以执行。
   *
   * @param request - 工具授权请求。
   * @param signal - 取消当前授权等待的信号。
   * @returns allow 表示允许，deny 表示拒绝。
   */
  authorize(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionDecision>

  /** 释放当前 Agent Run 的临时授权。 */
  readonly releaseRun?: (runId: string) => void

  /** 释放已经完成的任务授权；预算 checkpoint 不应调用它。 */
  readonly releaseTask?: (taskId: string) => void
}
