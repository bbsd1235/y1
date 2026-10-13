import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import {
  createAgentContext,
  type RuntimeModel,
  type RuntimeOptions,
} from './runtime.js'
import type {
  AgentEvent,
  AgentEventService,
} from './services/events.js'
import {
  AgentBudgetExceededError,
  type AgentRunOptions,
  type AgentLoopService,
} from './services/agent-loop.js'
import {
  parseAgentMode,
  type AgentMode,
} from './services/agent-mode.js'
import type { SessionPersistenceService } from './services/session-persistence.js'
import type { SessionService } from './services/session.js'
import type {
  PromptOptimizerService,
} from './services/prompt-optimizer.js'
import type {
  ContextManagerService,
  ContextSnapshot,
} from './services/context-manager.js'
import type {
  PermissionRequest,
  ToolApprovalHandler,
} from './services/permissions.js'

/**
 * CLI 默认最大模型轮次。
 *
 * 一个编码任务可能包含多轮读文件、写文件、运行命令和修复错误。
 */
export const DEFAULT_CLI_MAX_MODEL_ROUNDS = 64
export const DEFAULT_CLI_MAX_TOOL_CALLS = 128
export const DEFAULT_CLI_TIMEOUT_MS = 10 * 60 * 1000

/** CLI 参数。 */
export interface CliOptions {
  readonly model: RuntimeModel
  readonly mode: AgentMode
  readonly workspaceRoot: string
  readonly maxModelRounds: number
  readonly maxToolCalls: number
  readonly timeoutMs: number
  readonly prompt?: string
  readonly help: boolean
  readonly sessionId?: string
  readonly sessionDir?: string
}

/** 交互模式中的运行时。 */
interface InteractiveRuntime {
  readonly context: ReturnType<typeof createAgentContext>
  readonly agentLoop: AgentLoopService
  readonly contextManager: ContextManagerService
  readonly promptOptimizer: PromptOptimizerService
  readonly unsubscribeEvents: () => void
  readonly workspaceRoot: string
  readonly sessionId?: string
  readonly sessionPersistence?: SessionPersistenceService
}

/** 交互模式中确认是否启动 Worker 的处理器。 */
type PromptApprovalHandler = (
  prompt: string,
  signal?: AbortSignal,
) => boolean | Promise<boolean>

/** 交互命令。 */
type InteractiveCommand =
  | { readonly kind: 'exit' }
  | { readonly kind: 'help' }
  | { readonly kind: 'pwd' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'sessions' }
  | { readonly kind: 'context' }
  | { readonly kind: 'compact' }
  | { readonly kind: 'delete'; readonly sessionId: string }
  | { readonly kind: 'history' }
  | { readonly kind: 'new' }
  | { readonly kind: 'resume'; readonly sessionId: string }
  | { readonly kind: 'cd'; readonly path: string }
  | { readonly kind: 'mode'; readonly mode: AgentMode }
  | { readonly kind: 'mode-error'; readonly value: string }
  | { readonly kind: 'continue' }
  | { readonly kind: 'unknown'; readonly name: string }
  | undefined

/** 一次任务预算耗尽后可恢复的 CLI checkpoint。 */
interface AgentCheckpoint {
  readonly taskId: string
  readonly input: string
  readonly mode: AgentMode
  /** optimize 模式已经生成的 Worker 系统提示词。 */
  readonly systemPrompt?: string
}

/** 一次交互任务的执行结果。 */
interface InteractiveTaskOutcome {
  readonly status: 'completed' | 'checkpoint'
  readonly systemPrompt?: string
}

/** 一行交互输入的处理结果。 */
type InteractiveInputResult =
  | { readonly kind: 'continue' }
  | { readonly kind: 'exit' }
  | { readonly kind: 'mode'; readonly mode: AgentMode }
  | { readonly kind: 'runtime'; readonly runtime: InteractiveRuntime }
  | { readonly kind: 'task-complete' }
  | { readonly kind: 'checkpoint'; readonly checkpoint: AgentCheckpoint }

/**
 * 解析 CLI 参数。
 *
 * @param args - 命令行参数。
 * @returns 解析后的 CLI 配置。
 */
export function parseCliArgs(
  args: readonly string[],
): CliOptions {
  let model: RuntimeModel = 'deepseek'
  let mode: AgentMode = 'normal'
  let workspaceRoot = process.cwd()
  let maxModelRounds = DEFAULT_CLI_MAX_MODEL_ROUNDS
  let maxToolCalls = DEFAULT_CLI_MAX_TOOL_CALLS
  let timeoutMs = DEFAULT_CLI_TIMEOUT_MS
  let help = false
  let oncePrompt: string | undefined
  let sessionId: string | undefined
  let sessionDir: string | undefined
  const positionalArgs: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }

    if (arg === '--mock') {
      model = 'mock'
      continue
    }

    if (arg === '--mode') {
      mode = parseAgentMode(
        requireNextArgument(args, index, '--mode'),
      )
      index += 1
      continue
    }

    if (arg.startsWith('--mode=')) {
      mode = parseAgentMode(
        requireValueAfterEquals(arg, '--mode'),
      )
      continue
    }

    if (arg === '--workspace') {
      workspaceRoot = requireNextArgument(args, index, '--workspace')
      index += 1
      continue
    }

    if (arg.startsWith('--workspace=')) {
      workspaceRoot = requireValueAfterEquals(arg, '--workspace')
      continue
    }

    if (arg === '--max-model-rounds') {
      const value = requireNextArgument(args, index, arg)
      maxModelRounds = parsePositiveInteger(value, arg)
      index += 1
      continue
    }

    if (arg.startsWith('--max-model-rounds=')) {
      const value = requireValueAfterEquals(arg, '--max-model-rounds')
      maxModelRounds = parsePositiveInteger(value, '--max-model-rounds')
      continue
    }

    if (arg === '--max-tool-calls') {
      const value = requireNextArgument(args, index, '--max-tool-calls')
      maxToolCalls = parsePositiveInteger(value, '--max-tool-calls')
      index += 1
      continue
    }

    if (arg.startsWith('--max-tool-calls=')) {
      const value = requireValueAfterEquals(arg, '--max-tool-calls')
      maxToolCalls = parsePositiveInteger(value, '--max-tool-calls')
      continue
    }

    if (arg === '--timeout-ms') {
      const value = requireNextArgument(args, index, '--timeout-ms')
      timeoutMs = parsePositiveInteger(value, '--timeout-ms')
      index += 1
      continue
    }

    if (arg.startsWith('--timeout-ms=')) {
      const value = requireValueAfterEquals(arg, '--timeout-ms')
      timeoutMs = parsePositiveInteger(value, '--timeout-ms')
      continue
    }

    if (arg === '--once') {
      oncePrompt = requireNextArgument(args, index, '--once')
      index += 1
      continue
    }

    if (arg === '--session') {
      sessionId = requireNextArgument(args, index, '--session')
      index += 1
      continue
    }

    if (arg.startsWith('--session=')) {
      sessionId = requireValueAfterEquals(arg, '--session')
      continue
    }

    if (arg === '--session-dir') {
      sessionDir = requireNextArgument(args, index, '--session-dir')
      index += 1
      continue
    }

    if (arg.startsWith('--session-dir=')) {
      sessionDir = requireValueAfterEquals(arg, '--session-dir')
      continue
    }

    if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`)
    }

    positionalArgs.push(arg)
  }

  const positionalPrompt =
    positionalArgs.length === 0 ? undefined : positionalArgs.join(' ')

  if (oncePrompt !== undefined && positionalPrompt !== undefined) {
    throw new Error('--once cannot be combined with a positional prompt')
  }

  return {
    model,
    mode,
    workspaceRoot,
    maxModelRounds,
    maxToolCalls,
    timeoutMs,
    prompt: oncePrompt ?? positionalPrompt,
    help,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(sessionDir === undefined ? {} : { sessionDir }),
  }
}

/**
 * 启动 CLI。
 *
 * @param args - 命令行参数。
 */
export async function runCli(args: readonly string[]): Promise<void> {
  const options = parseCliArgs(args)

  if (options.help) {
    printHelp()
    return
  }

  if (options.prompt !== undefined) {
    const workspaceRoot = await resolveWorkspaceDirectory(
      process.cwd(),
      options.workspaceRoot,
    )
    const runtime = createRuntime(options, workspaceRoot, undefined, options.sessionId)

    try {
      await runOnce(
        runtime.agentLoop,
        runtime.promptOptimizer,
        workspaceRoot,
        options.prompt,
        options.mode,
      )
    } finally {
      disposeRuntime(runtime)
    }

    return
  }

  await runInteractive(options)
}

/** 执行一次任务，保持输出简洁以便脚本读取。 */
async function runOnce(
  agentLoop: AgentLoopService,
  promptOptimizer: PromptOptimizerService,
  workspaceRoot: string,
  prompt: string,
  mode: AgentMode,
): Promise<void> {
  const controller = new AbortController()
  const onSigint = (): void => {
    if (controller.signal.aborted) {
      return
    }

    controller.abort(new Error('agent run cancelled'))
    printCancelled()
  }

  process.once('SIGINT', onSigint)

  try {
    const answer = await runTaskByMode(
      agentLoop,
      promptOptimizer,
      workspaceRoot,
      prompt,
      mode,
      {
        signal: controller.signal,
      },
    )
    if (answer !== undefined) {
      process.stdout.write(`${answer}\n`)
    }
  } catch (error: unknown) {
    if (!controller.signal.aborted) {
      throw error
    }
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
}

/**
 * 启动交互模式。
 *
 * @param options - CLI 配置。
 */
async function runInteractive(options: CliOptions): Promise<void> {
  let workspaceRoot = await resolveWorkspaceDirectory(
    process.cwd(),
    options.workspaceRoot,
  )
  let currentMode: AgentMode = options.mode

  if (process.stdin.isTTY) {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    const approveTool = createCliApproval(readline)
    const approvePrompt = createCliPromptApproval(readline)
    let runtime = createRuntime(
      options,
      workspaceRoot,
      renderAgentEvent,
      options.sessionId ?? randomUUID(),
      approveTool,
    )
    let checkpoint: AgentCheckpoint | undefined
    let activeRunController: AbortController | undefined
    const onSigint = (): void => {
      if (activeRunController === undefined) {
        readline.close()
        return
      }

      if (!activeRunController.signal.aborted) {
        activeRunController.abort(new Error('agent run cancelled'))
        printCancelled()
      }
    }

    readline.on('SIGINT', onSigint)

    printWelcome(
      options,
      workspaceRoot,
      runtime.sessionId,
      currentMode,
    )

    try {

      while (true) {
        let input: string

        try {
          input = await readline.question(
            createPrompt(options.model, workspaceRoot, currentMode),
          )
        } catch {
          break
        }

        const controller = new AbortController()
        activeRunController = controller
        let result: Awaited<ReturnType<typeof handleInteractiveInput>>

        try {
          result = await handleInteractiveInput(
            input,
            options,
            runtime,
            workspaceRoot,
            controller.signal,
            currentMode,
            approvePrompt,
            approveTool,
            checkpoint,
          )
        } finally {
          if (activeRunController === controller) {
            activeRunController = undefined
          }
        }

        if (result.kind === 'exit') {
          break
        }

        if (result.kind === 'mode') {
          currentMode = result.mode
          printModeChanged(currentMode)
          continue
        }

        if (result.kind === 'checkpoint') {
          checkpoint = result.checkpoint
          continue
        }

        if (result.kind === 'task-complete') {
          checkpoint = undefined
          continue
        }

        if (result.kind === 'runtime') {
          checkpoint = undefined
          disposeRuntime(runtime)
          runtime = result.runtime
          workspaceRoot = result.runtime.workspaceRoot
          printRuntimeChanged(result.runtime, workspaceRoot)
        }
      }
    } finally {
      readline.removeListener('SIGINT', onSigint)
      readline.close()
      disposeRuntime(runtime)
    }
    return
  }

  const readline = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })
  let runtime = createRuntime(
    options,
    workspaceRoot,
    renderAgentEvent,
    options.sessionId ?? randomUUID(),
  )
  let activeRunController: AbortController | undefined
  let checkpoint: AgentCheckpoint | undefined
  const onSigint = (): void => {
    if (activeRunController === undefined) {
      readline.close()
      return
    }

    if (!activeRunController.signal.aborted) {
      activeRunController.abort(new Error('agent run cancelled'))
      printCancelled()
    }
  }

  process.on('SIGINT', onSigint)

  try {
    for await (const line of readline) {
      const controller = new AbortController()
      activeRunController = controller
      let result: Awaited<ReturnType<typeof handleInteractiveInput>>

      try {
        result = await handleInteractiveInput(
          line,
          options,
          runtime,
          workspaceRoot,
          controller.signal,
          currentMode,
          undefined,
          undefined,
          checkpoint,
        )
      } finally {
        if (activeRunController === controller) {
          activeRunController = undefined
        }
      }

      if (result.kind === 'exit') {
        break
      }

      if (result.kind === 'mode') {
        currentMode = result.mode
        printModeChanged(currentMode)
        continue
      }

      if (result.kind === 'checkpoint') {
        checkpoint = result.checkpoint
        continue
      }

      if (result.kind === 'task-complete') {
        checkpoint = undefined
        continue
      }

      if (result.kind === 'runtime') {
        checkpoint = undefined
        disposeRuntime(runtime)
        runtime = result.runtime
        workspaceRoot = result.runtime.workspaceRoot
        printRuntimeChanged(result.runtime, workspaceRoot)
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint)
    readline.close()
    disposeRuntime(runtime)
  }
}

/**
 * 处理一行交互输入。
 *
 * @param rawInput - 原始输入。
 * @param options - CLI 配置。
 * @param runtime - 当前运行时。
 * @param workspaceRoot - 当前 workspace 根目录。
 * @param signal - 当前 Agent Run 的取消信号。
 * @param mode - 当前 Agent 工作模式。
 * @param approvePrompt - optimize 模式启动 Worker 前的确认处理器。
 * @param approveTool - 高风险工具确认处理器。
 * @returns 处理结果。
 */
async function handleInteractiveInput(
  rawInput: string,
  options: CliOptions,
  runtime: InteractiveRuntime,
  workspaceRoot: string,
  signal?: AbortSignal,
  mode: AgentMode = 'normal',
  approvePrompt?: PromptApprovalHandler,
  approveTool?: ToolApprovalHandler,
  checkpoint?: AgentCheckpoint,
): Promise<InteractiveInputResult> {
  const input = rawInput.trim()

  if (input.length === 0) {
    return { kind: 'continue' }
  }

  const command = parseInteractiveCommand(input)

  if (command?.kind === 'exit') {
    return { kind: 'exit' }
  }

  if (command?.kind === 'help') {
    printInteractiveHelp()
    return { kind: 'continue' }
  }

  if (command?.kind === 'mode-error') {
    if (command.value.length === 0) {
      printError('usage: /mode <normal|optimize>')
    } else {
      printError(
        `invalid mode "${command.value}"; use /mode normal or /mode optimize`,
      )
    }
    return { kind: 'continue' }
  }

  if (command?.kind === 'mode') {
    return command
  }

  if (command?.kind === 'continue') {
    if (checkpoint === undefined) {
      printError('no task checkpoint is available')
      return { kind: 'continue' }
    }

    const outcome = await runInteractiveTask(
      runtime.agentLoop,
      runtime.promptOptimizer,
      workspaceRoot,
      '',
      signal,
      checkpoint.mode,
      approvePrompt,
      {
        resume: true,
        taskId: checkpoint.taskId,
        systemPrompt: checkpoint.systemPrompt,
      },
    )
    return outcome.status === 'checkpoint'
      ? { kind: 'checkpoint', checkpoint }
      : { kind: 'task-complete' }
  }

  if (command?.kind === 'context') {
    printContext(runtime.contextManager.current())
    return { kind: 'continue' }
  }

  if (command?.kind === 'compact') {
    try {
      const snapshot = await runtime.contextManager.compact({ signal })
      printContext(snapshot)
    } catch (error: unknown) {
      if (signal?.aborted) {
        printCancelled()
      } else {
        printError(getErrorMessage(error))
      }
    }
    return { kind: 'continue' }
  }

  if (command?.kind === 'pwd') {
    printWorkspaceChanged(workspaceRoot, false)
    return { kind: 'continue' }
  }

  if (command?.kind === 'clear') {
    clearScreen()
    printWelcome(
      options,
      workspaceRoot,
      runtime.sessionId,
      mode,
    )
    return { kind: 'continue' }
  }

  if (command?.kind === 'sessions') {
    printSessions(runtime.sessionPersistence)
    return { kind: 'continue' }
  }

  if (command?.kind === 'delete') {
    if (command.sessionId.length === 0) {
      printError('usage: /delete <session-id>')
      return { kind: 'continue' }
    }

    const persistence = runtime.sessionPersistence
    if (persistence === undefined) {
      printError('session persistence is not available')
      return { kind: 'continue' }
    }

    try {
      if (!persistence.delete(command.sessionId)) {
        printError(`session not found: ${command.sessionId}`)
        return { kind: 'continue' }
      }

      process.stdout.write(
        `${paint('green', 'session deleted:')} ${command.sessionId}\n`,
      )

      if (command.sessionId !== runtime.sessionId) {
        return { kind: 'continue' }
      }

      return {
        kind: 'runtime',
        runtime: createRuntime(
          options,
          workspaceRoot,
          renderAgentEvent,
          randomUUID(),
          approveTool,
        ),
      }
    } catch (error: unknown) {
      printError(getErrorMessage(error))
      return { kind: 'continue' }
    }
  }

  if (command?.kind === 'history') {
    printHistory(runtime.context.get<SessionService>('session'))
    return { kind: 'continue' }
  }

  if (command?.kind === 'new') {
    return {
      kind: 'runtime',
      runtime: createRuntime(
        options,
        workspaceRoot,
        renderAgentEvent,
        randomUUID(),
        approveTool,
      ),
    }
  }

  if (command?.kind === 'resume') {
    const persistence = runtime.sessionPersistence
    if (persistence === undefined) {
      printError('session persistence is not available')
      return { kind: 'continue' }
    }

    try {
      const summary = persistence
        .list()
        .find((item) => item.sessionId === command.sessionId)
      if (summary === undefined) {
        throw new Error(`session not found: ${command.sessionId}`)
      }

      const nextWorkspaceRoot = await resolveWorkspaceDirectory(
        workspaceRoot,
        summary.cwd,
      )
      return {
        kind: 'runtime',
        runtime: createRuntime(
          options,
          nextWorkspaceRoot,
          renderAgentEvent,
          command.sessionId,
          approveTool,
        ),
      }
    } catch (error: unknown) {
      printError(getErrorMessage(error))
      return { kind: 'continue' }
    }
  }

  if (command?.kind === 'unknown') {
    printError(`unknown command: ${command.name}; use /help for commands`)
    return { kind: 'continue' }
  }

  if (command?.kind === 'cd') {
    if (command.path.length === 0) {
      printError('usage: /cd <directory>')
      return { kind: 'continue' }
    }

    try {
      const nextWorkspaceRoot = await resolveWorkspaceDirectory(
        workspaceRoot,
        command.path,
      )
      const nextRuntime = createRuntime(
        options,
        nextWorkspaceRoot,
        renderAgentEvent,
        randomUUID(),
        approveTool,
      )

      return {
        kind: 'runtime',
        runtime: nextRuntime,
      }
    } catch (error: unknown) {
      printError(getErrorMessage(error))
      return { kind: 'continue' }
    }
  }

  const taskId = randomUUID()
  const outcome = await runInteractiveTask(
    runtime.agentLoop,
    runtime.promptOptimizer,
    workspaceRoot,
    input,
    signal,
    mode,
    approvePrompt,
    { taskId },
  )
  if (outcome.status === 'checkpoint') {
    return {
      kind: 'checkpoint',
      checkpoint: {
        taskId,
        input,
        mode,
        ...(outcome.systemPrompt === undefined
          ? {}
          : { systemPrompt: outcome.systemPrompt }),
      },
    }
  }
  return { kind: 'task-complete' }
}

/** 执行 Agent 任务并显示执行状态。 */
async function runInteractiveTask(
  agentLoop: AgentLoopService,
  promptOptimizer: PromptOptimizerService,
  workspaceRoot: string,
  input: string,
  signal?: AbortSignal,
  mode: AgentMode = 'normal',
  approvePrompt?: PromptApprovalHandler,
  taskOptions: {
    readonly resume?: boolean
    readonly taskId?: string
    readonly systemPrompt?: string
  } = {},
): Promise<InteractiveTaskOutcome> {
  let optimizedPrompt: string | undefined

  try {
    const taskId = taskOptions.taskId ?? randomUUID()
    const answer = taskOptions.resume
      ? await agentLoop.run('', {
          signal,
          taskId,
          systemPrompt: taskOptions.systemPrompt,
          resume: true,
        })
      : await runTaskByMode(
          agentLoop,
          promptOptimizer,
          workspaceRoot,
          input,
          mode,
          { signal },
          taskId,
          (prompt) => {
            optimizedPrompt = prompt
          },
          approvePrompt,
        )
    if (answer !== undefined) {
      printAssistant(answer)
    }
    return {
      status: 'completed',
      ...(optimizedPrompt === undefined
        ? {}
        : { systemPrompt: optimizedPrompt }),
    }
  } catch (error: unknown) {
    if (signal?.aborted) {
      return { status: 'completed' }
    }

    if (error instanceof AgentBudgetExceededError) {
      printError(`${error.message}; checkpoint saved, use /continue`)
      return {
        status: 'checkpoint',
        ...(optimizedPrompt === undefined
          ? {}
          : { systemPrompt: optimizedPrompt }),
      }
    }

    printError(getErrorMessage(error))
    return { status: 'completed' }
  }
}

/**
 * 根据 CLI 选择进入普通模式或优化模式的执行入口。
 *
 * 普通模式直接运行 Worker；优化模式先生成提示词，再将其作为
 * Worker 的 system prompt 执行。
 *
 * @param agentLoop - 当前 Working Agent 的 Agent Loop。
 * @param input - 用户任务。
 * @param mode - 当前 Agent 模式。
 * @param options - 当前运行的控制参数。
 * @returns Agent 的最终回答。
 */
async function runTaskByMode(
  agentLoop: AgentLoopService,
  promptOptimizer: PromptOptimizerService,
  workspaceRoot: string,
  input: string,
  mode: AgentMode,
  options: Pick<AgentRunOptions, 'signal'>,
  taskId: string = randomUUID(),
  onOptimizedPrompt?: (prompt: string) => void,
  approvePrompt?: PromptApprovalHandler,
): Promise<string | undefined> {
  switch (mode) {
    case 'normal':
      return agentLoop.run(input, { ...options, taskId })
    case 'optimize':
      return runOptimizeMode(
        agentLoop,
        promptOptimizer,
        workspaceRoot,
        input,
        options,
        taskId,
        onOptimizedPrompt,
        approvePrompt,
      )
  }
}

/** 生成、展示并执行带有优化系统指令的 Worker。 */
async function runOptimizeMode(
  agentLoop: AgentLoopService,
  promptOptimizer: PromptOptimizerService,
  workspaceRoot: string,
  input: string,
  options: Pick<AgentRunOptions, 'signal'>,
  taskId: string,
  onOptimizedPrompt?: (prompt: string) => void,
  approvePrompt?: PromptApprovalHandler,
): Promise<string | undefined> {
  const optimizedPrompt = await promptOptimizer.optimize(input, {
    ...options,
    workspaceRoot,
  })
  printOptimizedPrompt(optimizedPrompt)

  if (approvePrompt !== undefined) {
    const approved = await approvePrompt(optimizedPrompt, options.signal)
    if (!approved) {
      process.stdout.write(
        `${paint('yellow', 'optimized prompt rejected; task not started')}\n`,
      )
      return undefined
    }
  }

  onOptimizedPrompt?.(optimizedPrompt)
  return agentLoop.run(input, {
    ...options,
    taskId,
    systemPrompt: optimizedPrompt,
  })
}

/** 在 CLI 中展示 Prompt Optimizer 生成的工作提示词。 */
function printOptimizedPrompt(prompt: string): void {
  process.stdout.write(`\n${paint('cyan', 'optimized Worker system prompt')}\n`)
  for (const line of prompt.split('\n')) {
    process.stdout.write(`  ${line}\n`)
  }
  process.stdout.write('\n')
}

/** 创建 CLI 的高风险工具确认处理器。 */
function createCliApproval(
  readline: ReadlineInterface,
): ToolApprovalHandler {
  return async (request, signal) => {
    process.stdout.write(`\n${paint('yellow', 'permission required')}\n`)
    process.stdout.write(`  tool: ${request.toolName}\n`)
    process.stdout.write(`  risk: ${request.risk}\n`)
    process.stdout.write(`  ${formatPermissionTarget(request)}\n`)

    const prompt =
      `  ${paint('yellow', 'allow?')} ` +
      `${paint('dim', '[y] once, [a] task, [s] session, [n] deny: ')}`
    const answer = signal === undefined
      ? await readline.question(prompt)
      : await readline.question(prompt, { signal })
    const choice = answer.trim().toLowerCase()
    if (choice === 'a' || choice === 'all' || choice === 'task') {
      return 'allow-run'
    }
    if (choice === 's' || choice === 'session') {
      return 'allow-session'
    }
    if (choice === 'y' || choice === 'yes') {
      return 'allow-once'
    }
    return 'deny'
  }
}

/** 创建优化后 Worker 提示词的确认处理器。 */
function createCliPromptApproval(
  readline: ReadlineInterface,
): PromptApprovalHandler {
  return async (_optimizedPrompt, signal) => {
    const prompt =
      `  ${paint('yellow', 'run Worker with this system prompt?')} ` +
      `${paint('dim', '[y/N] ')}`
    const answer = signal === undefined
      ? await readline.question(prompt)
      : await readline.question(prompt, { signal })
    return /^(y|yes)$/i.test(answer.trim())
  }
}

/** 生成不会直接倾倒大段文件内容的授权摘要。 */
function formatPermissionTarget(request: PermissionRequest): string {
  if (request.toolName === 'write_file') {
    const path = typeof request.arguments.path === 'string'
      ? request.arguments.path
      : '<unknown path>'
    const content = typeof request.arguments.content === 'string'
      ? request.arguments.content
      : ''
    return `write ${path} (${content.length} chars)`
  }

  if (request.toolName === 'run_command') {
    const command = typeof request.arguments.command === 'string'
      ? request.arguments.command
      : '<unknown command>'
    const cwd = typeof request.arguments.cwd === 'string'
      ? request.arguments.cwd
      : '.'
    return `run in ${cwd}: ${truncateForDisplay(command, 240)}`
  }

  return 'execute requested operation'
}

/** 截断终端摘要，避免模型参数淹没用户确认界面。 */
function truncateForDisplay(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`
}

/**
 * 创建一个运行时。
 *
 * @param options - CLI 配置。
 * @param workspaceRoot - 已验证的 workspace 根目录。
 * @returns 运行时对象。
 */
function createRuntime(
  options: RuntimeOptions,
  workspaceRoot: string,
  observer?: (event: AgentEvent) => void,
  sessionId?: string,
  approveTool?: ToolApprovalHandler,
): InteractiveRuntime {
  const context = createAgentContext({
    model: options.model,
    workspaceRoot,
    maxModelRounds: options.maxModelRounds,
    maxToolCalls: options.maxToolCalls,
    timeoutMs: options.timeoutMs,
    sessionId,
    sessionDir: options.sessionDir,
    approveTool,
  })
  const events = context.get<AgentEventService>(
    'agent-events',
  )
  const unsubscribeEvents =
    observer === undefined
      ? () => {}
      : events.subscribe(observer)

  return {
    context,
    agentLoop: context.get<AgentLoopService>('agent-loop'),
    contextManager: context.get<ContextManagerService>('context-manager'),
    promptOptimizer: context.get<PromptOptimizerService>('prompt-optimizer'),
    unsubscribeEvents,
    workspaceRoot,
    sessionId,
    sessionPersistence: context.has('session-persistence')
      ? context.get<SessionPersistenceService>('session-persistence')
      : undefined,
  }
}

/**
 * 销毁一个交互运行时。
 *
 * 先移除观察者，再销毁 Context，避免切换 workspace 时旧运行时
 * 的事件继续写入当前 CLI。
 *
 * @param runtime - 要销毁的运行时。
 */
function disposeRuntime(runtime: InteractiveRuntime): void {
  runtime.unsubscribeEvents()
  runtime.context.dispose()
}

/**
 * 解析交互命令。
 *
 * `/mode` 的参数在这里转换为 AgentMode；缺失或非法参数单独返回，
 * 由交互处理器打印使用提示，不会创建新的 Runtime。
 *
 * @param input - 已去除首尾空白的交互输入。
 * @returns 解析后的交互命令，普通文本返回 undefined。
 */
export function parseInteractiveCommand(
  input: string,
): InteractiveCommand {
  if (
    input === '/exit' ||
    input === '/quit' ||
    input === 'exit' ||
    input === 'quit'
  ) {
    return { kind: 'exit' }
  }

  if (input === '/help') {
    return { kind: 'help' }
  }

  if (input === '/pwd') {
    return { kind: 'pwd' }
  }

  if (input === '/clear') {
    return { kind: 'clear' }
  }

  if (input === '/sessions') {
    return { kind: 'sessions' }
  }

  if (input === '/context') {
    return { kind: 'context' }
  }

  if (input === '/compact') {
    return { kind: 'compact' }
  }

  if (input === '/delete') {
    return { kind: 'delete', sessionId: '' }
  }

  if (input.startsWith('/delete ')) {
    return {
      kind: 'delete',
      sessionId: input.slice('/delete '.length).trim(),
    }
  }

  if (input === '/history') {
    return { kind: 'history' }
  }

  if (input === '/new') {
    return { kind: 'new' }
  }

  if (input === '/resume') {
    return { kind: 'resume', sessionId: '' }
  }

  if (input.startsWith('/resume ')) {
    return {
      kind: 'resume',
      sessionId: input.slice('/resume '.length).trim(),
    }
  }

  if (input === '/cd') {
    return { kind: 'cd', path: '' }
  }

  if (input.startsWith('/cd ')) {
    return {
      kind: 'cd',
      path: input.slice('/cd '.length).trim(),
    }
  }

  if (input === '/mode') {
    return { kind: 'mode-error', value: '' }
  }

  if (input.startsWith('/mode ')) {
    const value = input.slice('/mode '.length).trim()
    if (value === 'normal' || value === 'optimize') {
      return { kind: 'mode', mode: value }
    }

    return { kind: 'mode-error', value }
  }

  if (input === '/continue') {
    return { kind: 'continue' }
  }

  if (input.startsWith('/')) {
    return {
      kind: 'unknown',
      name: input.split(/\s+/)[0] ?? input,
    }
  }

  return undefined
}

/**
 * 解析并验证 workspace 目录。
 *
 * 相对路径相对于当前 workspace 解析，支持 /cd ..、/cd ~ 等形式。
 *
 * @param currentRoot - 当前 workspace 根目录。
 * @param requestedPath - 用户输入的目标路径。
 * @returns 真实的目录路径。
 */
async function resolveWorkspaceDirectory(
  currentRoot: string,
  requestedPath: string,
): Promise<string> {
  const expandedPath = expandHomePath(requestedPath)
  const targetPath = isAbsolute(expandedPath)
    ? expandedPath
    : resolve(currentRoot, expandedPath)
  const targetRoot = await realpath(targetPath)
  const targetStat = await stat(targetRoot)

  if (!targetStat.isDirectory()) {
    throw new Error(
      `workspace path is not a directory: ${requestedPath}`,
    )
  }

  return targetRoot
}

/** 展开用户目录缩写。 */
function expandHomePath(value: string): string {
  if (value === '~') {
    return homedir()
  }

  if (value.startsWith('~/')) {
    return resolve(homedir(), value.slice(2))
  }

  return value
}

/** 打印欢迎信息。 */
function printWelcome(
  options: CliOptions,
  workspaceRoot: string,
  sessionId?: string,
  mode: AgentMode = options.mode,
): void {
  process.stdout.write('\n')
  process.stdout.write(`${paint('cyan', '+-- mini-dsh coding agent')}\n`)
  process.stdout.write(
    `${paint('dim', '|')} model: ${paint('yellow', options.model)}\n`,
  )
  process.stdout.write(
    `${paint('dim', '|')} mode: ${paint('yellow', mode)}\n`,
  )
  process.stdout.write(
    `${paint('dim', '|')} workspace: ${workspaceRoot}\n`,
  )
  if (sessionId !== undefined) {
    process.stdout.write(
      `${paint('dim', '|')} session: ${sessionId}\n`,
    )
  }
  process.stdout.write(
    `${paint('dim', '|')} type ${paint('green', '/help')} for commands\n`,
  )
  process.stdout.write(`${paint('cyan', '+-----------------------------')}\n\n`)
}

/** 创建交互提示符。 */
function createPrompt(
  model: RuntimeModel,
  workspaceRoot: string,
  mode: AgentMode,
): string {
  return `${paint('cyan', 'mini-dsh')} ${paint('yellow', model)} ${paint('magenta', mode)} ${paint('dim', workspaceRoot)} ${paint('green', '> ')}`
}

/** 打印交互帮助。 */
function printInteractiveHelp(): void {
  process.stdout.write(
    [
      '',
      paint('cyan', 'Commands'),
      `  ${paint('green', '/mode <normal|optimize>')} switch agent mode`,
      `  ${paint('green', '/cd <path>')}   switch workspace and reset session`,
      `  ${paint('green', '/sessions')}     list persisted sessions`,
      `  ${paint('green', '/context')}      show model context usage`,
      `  ${paint('green', '/compact')}      summarize older context now`,
      `  ${paint('green', '/delete <id>')}  delete a persisted session`,
      `  ${paint('green', '/resume <id>')}  resume a persisted session`,
      `  ${paint('green', '/history')}      show current message history`,
      `  ${paint('green', '/new')}          create a new session`,
      `  ${paint('green', '/pwd')}          show current workspace`,
      `  ${paint('green', '/clear')}        clear the terminal`,
      `  ${paint('green', '/help')}         show this help`,
      `  ${paint('green', '/exit')}         exit mini-dsh`,
      '',
    ].join('\n') + '\n',
  )
}

/** 打印 workspace 变化。 */
function printWorkspaceChanged(
  workspaceRoot: string,
  includeResetNote = true,
): void {
  process.stdout.write(`${paint('green', 'workspace:')} ${workspaceRoot}\n`)

  if (includeResetNote) {
    process.stdout.write(
      `${paint('dim', 'session reset; tools now use the new workspace')}\n`,
    )
  }
}

/** 打印运行时切换信息。 */
function printRuntimeChanged(
  runtime: InteractiveRuntime,
  workspaceRoot: string,
): void {
  printWorkspaceChanged(workspaceRoot, false)
  if (runtime.sessionId !== undefined) {
    process.stdout.write(`${paint('dim', `session: ${runtime.sessionId}`)}\n`)
  }
  process.stdout.write('\n')
}

/** 打印当前 Agent 模式变化。 */
function printModeChanged(mode: AgentMode): void {
  process.stdout.write(
    `${paint('green', 'agent mode:')} ${paint('yellow', mode)}\n`,
  )
}

/** 打印当前持久化根目录中的会话列表。 */
function printSessions(
  persistence: SessionPersistenceService | undefined,
): void {
  if (persistence === undefined) {
    printError('session persistence is not available')
    return
  }

  const sessions = persistence.list()
  if (sessions.length === 0) {
    process.stdout.write('no sessions\n')
    return
  }

  process.stdout.write(`\n${paint('cyan', 'sessions')}\n`)
  for (const session of sessions) {
    const current = session.sessionId === persistence.sessionId ? '*' : ' '
    const firstUserInput = formatSessionInput(session.firstUserInput)
    process.stdout.write(
      `${current} ${session.sessionId} ${firstUserInput} ` +
        `${paint('dim', `messages=${session.messageCount} cwd=${session.cwd}`)}\n`,
    )
  }
  process.stdout.write('\n')
}

/** 将首条用户输入压缩成适合 Session 列表显示的单行标题。 */
function formatSessionInput(input: string | undefined): string {
  if (input === undefined || input.trim().length === 0) {
    return '(empty session)'
  }

  const singleLine = input.replace(/\s+/g, ' ').trim()
  return `"${truncateForDisplay(singleLine, 80)}"`
}

/** 以可读形式展示当前会话的模型可见消息。 */
function printHistory(session: SessionService): void {
  const messages = session.messages()
  if (messages.length === 0) {
    process.stdout.write('session history is empty\n')
    return
  }

  process.stdout.write(`\n${paint('cyan', 'history')}\n`)
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant' && message.content === null) {
      const calls = message.toolCalls
        .map((call) => `${call.name}(${JSON.stringify(call.arguments)})`)
        .join(', ')
      process.stdout.write(`${index + 1}. assistant tool-call: ${calls}\n`)
      continue
    }

    process.stdout.write(`${index + 1}. ${message.role}: ${message.content}\n`)
  }
  process.stdout.write('\n')
}

/** 打印当前模型上下文的估算用量。 */
function printContext(snapshot: ContextSnapshot | undefined): void {
  if (snapshot === undefined) {
    process.stdout.write(
      `${paint('yellow', 'context:')} no model context has been built yet\n`,
    )
    return
  }

  const usage = snapshot.usage
  const percentage = (usage.usageRatio * 100).toFixed(1)
  const state = usage.compacted ? 'compacted' : 'full'

  process.stdout.write(`\n${paint('cyan', 'context')}\n`)
  process.stdout.write(
    `  ${paint('dim', 'usage:')} ${usage.estimatedTokens} / ` +
      `${usage.maxTokens} tokens (${percentage}%)\n`,
  )
  process.stdout.write(`  ${paint('dim', 'state:')} ${state}\n`)
  process.stdout.write(
    `  ${paint('dim', 'messages:')} ${usage.includedMessageCount} / ` +
      `${usage.originalMessageCount}\n`,
  )
  process.stdout.write(
    `  ${paint('dim', 'tools:')} ${snapshot.tools.length}\n`,
  )
  process.stdout.write(
    `  ${paint('dim', 'system prompt:')} ` +
      `${usage.systemPromptTokens} tokens\n`,
  )
  process.stdout.write(
    `  ${paint('dim', 'message history:')} ` +
      `${usage.messageTokens} tokens\n`,
  )
  process.stdout.write(
    `  ${paint('dim', 'tool schemas:')} ${usage.toolTokens} tokens\n`,
  )
  process.stdout.write(
    `  ${paint('dim', 'task metadata:')} ${usage.taskTokens} tokens\n\n`,
  )
}

/** 打印模型回答。 */
function printAssistant(answer: string): void {
  const lines = answer.split('\n')

  process.stdout.write(`\n${paint('magenta', 'assistant')}\n`)

  for (const line of lines) {
    process.stdout.write(`  ${line}\n`)
  }

  process.stdout.write('\n')
}

/**
 * 渲染 Agent 运行时事件。
 *
 * 事件观察只负责显示状态，不参与 Agent 的控制流。
 *
 * @param event - Agent 运行时事件。
 */
function renderAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'agent-start':
      process.stdout.write(
        `\n${paint('dim', `run ${event.runId.slice(0, 8)} started`)}\n`,
      )
      return

    case 'model-request-start':
      process.stdout.write(
        `  ${paint('dim', `step ${event.step + 1} model request`)}\n`,
      )
      return

    case 'model-response':
      process.stdout.write(
        `  ${paint('dim', `model -> ${event.kind}`)} ` +
          `${paint('dim', `(${event.durationMs}ms)`)}\n`,
      )
      return

    case 'tool-start':
      process.stdout.write(
        `  ${paint('yellow', `tool ${event.toolName}`)}\n`,
      )
      return

    case 'tool-end':
      if (event.status === 'success') {
        process.stdout.write(
          `  ${paint('green', 'ok')} ${event.toolName} ` +
            `${paint('dim', `(${event.durationMs}ms)`)}\n`,
        )
      } else {
        process.stdout.write(
          `  ${paint('red', 'failed')} ${event.toolName} ` +
            `${paint('dim', `(${event.durationMs}ms)`)}\n`,
        )
      }
      return

    case 'agent-final':
      process.stdout.write(
        `  ${paint('green', 'completed')} ` +
          `${paint('dim', `(${event.durationMs}ms)`)}\n`,
      )
      return

    case 'agent-error':
      process.stdout.write(
        `  ${paint(
          'red',
          event.error === 'agent run cancelled'
            ? 'agent cancelled'
            : 'agent failed',
        )} ` +
          `${paint('dim', `(${event.durationMs}ms)`)}\n`,
      )
      return
  }
}

/** 清屏。 */
function clearScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[H')
  }
}

/** 输出错误信息。 */
function printError(message: string): void {
  process.stderr.write(`${paint('red', `error: ${message}`)}\n`)
}

/** 显示取消当前 Agent Run 的结果。 */
function printCancelled(): void {
  process.stdout.write(`\n${paint('yellow', 'agent cancelled')}\n`)
}

/**
 * 终端颜色输出。
 *
 * NO_COLOR 或非 TTY 环境下返回纯文本。
 */
function paint(
  color: 'cyan' | 'yellow' | 'green' | 'magenta' | 'red' | 'dim',
  text: string,
): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR !== undefined) {
    return text
  }

  const codes = {
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    green: '\x1b[32m',
    magenta: '\x1b[35m',
    red: '\x1b[31m',
    dim: '\x1b[2m',
  } as const

  return `${codes[color]}${text}\x1b[0m`
}

/** 输出帮助信息。 */
function printHelp(): void {
  process.stdout.write(
    [
      'mini-dsh usage:',
      '',
      '  npm run dev',
      '  npm run dev -- "your task"',
      '',
      'options:',
      '  --mock                 use the mock model',
      '  --mode <normal|optimize> set the initial agent mode',
      '  --workspace <path>     set initial workspace',
      '  --max-model-rounds N   set model request round limit',
      '  --max-tool-calls N     set tool call limit',
      '  --timeout-ms N         set task timeout',
      '  --session <id>         resume or create a persistent session',
      '  --session-dir <path>   set JSONL session directory',
      '  --once <prompt>        run one task and exit',
      '  --help                 show this help',
      '',
      'interactive commands:',
      '  /mode <normal|optimize> switch agent mode',
      '  /continue              continue the last budget-limited task',
      '  /cd <path>             switch workspace and reset session',
      '  /sessions              list persisted sessions',
      '  /context               show model context usage',
      '  /compact               summarize older context now',
      '  /delete <id>           delete a persisted session',
      '  /resume <id>           resume a persisted session',
      '  /history               show current message history',
      '  /new                   create a new session',
      '  /pwd                   show current workspace',
      '  /clear                 clear the terminal',
      '  /help                  show command help',
      '  /exit                  exit mini-dsh',
      '',
    ].join('\n'),
  )
}

/** 获取下一个参数。 */
function requireNextArgument(
  args: readonly string[],
  index: number,
  option: string,
): string {
  const value = args[index + 1]

  if (
    value === undefined ||
    value.trim().length === 0 ||
    value.startsWith('-')
  ) {
    throw new Error(`${option} requires a value`)
  }

  return value
}

/** 获取等号后面的参数。 */
function requireValueAfterEquals(
  arg: string,
  option: string,
): string {
  const separatorIndex = arg.indexOf('=')
  const value = arg.slice(separatorIndex + 1)

  if (value.trim().length === 0) {
    throw new Error(`${option} requires a value`)
  }

  return value
}

/** 解析正整数。 */
function parsePositiveInteger(
  value: string,
  option: string,
): number {
  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer`)
  }

  return parsed
}

/** 将未知错误转换为文本。 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

/** 仅在该文件被直接执行时启动 CLI。 */
const currentModulePath = resolve(fileURLToPath(import.meta.url))
const invokedModulePath =
  process.argv[1] === undefined
    ? undefined
    : resolve(process.argv[1])

if (
  invokedModulePath !== undefined &&
  invokedModulePath === currentModulePath
) {
  void runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`fatal: ${getErrorMessage(error)}\n`)
    process.exitCode = 1
  })
}
