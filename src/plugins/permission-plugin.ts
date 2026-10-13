import type { MiniPlugin } from '../plugin.js'
import type {
  PermissionDecision,
  PermissionRequest,
  PermissionService,
  ToolApprovalHandler,
} from '../services/permissions.js'
import type { ToolArguments } from '../services/tools.js'

/** Permission Plugin 配置。 */
export interface PermissionPluginOptions {
  /** 写文件或执行 Shell 前调用的用户确认函数。 */
  readonly approve?: ToolApprovalHandler
}

/** 默认工具权限 Provider。 */
export class DefaultPermissionService implements PermissionService {
  private readonly sessionGrants = new Set<string>()
  private readonly taskGrants = new Map<string, Set<string>>()
  private readonly runGrants = new Map<string, Set<string>>()
  /**
   * @param approve - 高风险工具的授权询问函数。
   */
  constructor(private readonly approve?: ToolApprovalHandler) {}

  /** 只读自动允许，高风险工具没有确认函数时拒绝。 */
  async authorize(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    throwIfAborted(signal)

    if (request.risk === 'read-only' || request.risk === 'agent-state') {
      return 'allow'
    }

    if (request.risk === 'shell-low') {
      return 'allow'
    }

    const key = grantKey(request.toolName, request.risk)
    if (this.sessionGrants.has(key)) {
      return 'allow'
    }
    if (
      request.taskId !== undefined &&
      this.taskGrants.get(request.taskId)?.has(key) === true
    ) {
      return 'allow'
    }
    if (this.runGrants.get(request.runId)?.has(key) === true) {
      return 'allow'
    }

    if (this.approve === undefined) {
      return 'deny'
    }

    const decision = await this.approve(request, signal)
    throwIfAborted(signal)
    const normalized = normalizeApproval(decision)
    if (normalized === 'allow-run') {
      if (request.taskId !== undefined) {
        let grants = this.taskGrants.get(request.taskId)
        if (grants === undefined) {
          grants = new Set<string>()
          this.taskGrants.set(request.taskId, grants)
        }
        grants.add(key)
        return 'allow'
      }

      let grants = this.runGrants.get(request.runId)
      if (grants === undefined) {
        grants = new Set<string>()
        this.runGrants.set(request.runId, grants)
      }
      grants.add(key)
      return 'allow'
    }
    if (normalized === 'allow-session') {
      this.sessionGrants.add(key)
      return 'allow'
    }
    return normalized === 'allow-once' ? 'allow' : 'deny'
  }

  /** 清理一次 Agent Run 的临时授权。 */
  releaseRun(runId: string): void {
    this.runGrants.delete(runId)
  }

  /** 清理已经完成任务的授权，避免长期运行时积累临时状态。 */
  releaseTask(taskId: string): void {
    this.taskGrants.delete(taskId)
  }
}

/** 将工具和风险组合为稳定授权键。 */
function grantKey(toolName: string, risk: string): string {
  return `${toolName}:${risk}`
}

/** 将旧 boolean/allow 返回值和新的授权范围统一起来。 */
function normalizeApproval(
  decision: Awaited<ReturnType<NonNullable<PermissionPluginOptions['approve']>>>,
): 'allow-once' | 'allow-run' | 'allow-session' | 'deny' {
  if (
    decision === true ||
    decision === 'allow' ||
    decision === 'allow-once'
  ) {
    return 'allow-once'
  }
  if (decision === 'allow-run' || decision === 'allow-session') return decision
  return 'deny'
}

/** 在进入权限层前保持取消原因不被吞掉。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw getAbortError(signal)
  }
}

/** 获取 AbortSignal 的稳定错误对象。 */
function getAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('agent run cancelled')
}

/** 创建工具权限插件。 */
export function createPermissionPlugin(
  options: PermissionPluginOptions = {},
): MiniPlugin {
  return {
    name: 'permissions',

    setup(context) {
      const permissions = new DefaultPermissionService(options.approve)
      return context.provide<PermissionService>('permissions', permissions)
    },
  }
}

/** 默认拒绝高风险工具的权限插件。 */
export const permissionPlugin = createPermissionPlugin()
