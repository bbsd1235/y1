/**
 * CLI 当前选择的 Agent 工作模式。
 *
 * normal 模式直接执行现有 Agent Loop；
 * optimize 模式只优化并展示工作提示词。
 */
export type AgentMode = 'normal' | 'optimize'

/**
 * 解析 CLI 传入的 Agent 模式。
 *
 * @param value - CLI 中 `--mode` 后面的值。
 * @returns 合法的 Agent 模式。
 */
export function parseAgentMode(value: string): AgentMode {
  if (value === 'normal' || value === 'optimize') {
    return value
  }

  throw new Error(
    `--mode must be either "normal" or "optimize", got "${value}"`,
  )
}
