import { spawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'
import type { MiniPlugin } from '../plugin.js'
import type {
  ToolArguments,
  ToolsService,
} from '../services/tools.js'

/**
 * Shell 工具插件配置。
 */
export interface ShellToolsPluginOptions {
  /**
   * 命令允许使用的根目录。
   *
   * 默认使用当前进程工作目录。
   */
  readonly rootDir?: string

  /**
   * 单条命令的最大执行时间。
   *
   * 默认 30 秒。
   */
  readonly timeoutMs?: number

  /**
   * stdout 和 stderr 各自的最大字符数。
   *
   * 默认 32 KiB。
   */
  readonly maxOutputChars?: number
}

/**
 * 默认命令超时时间。
 */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 默认输出限制。
 */
const DEFAULT_MAX_OUTPUT_CHARS = 32 * 1024

/**
 * 创建 Shell 工具插件。
 *
 * @param options - Shell 工具配置。
 * @returns Shell 工具插件。
 */
export function createShellToolsPlugin(
  options: ShellToolsPluginOptions = {},
): MiniPlugin {
  const rootDir = resolve(
    options.rootDir ?? process.cwd(),
  )

  const timeoutMs =
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const maxOutputChars =
    options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS

  validatePositiveInteger(timeoutMs, 'timeoutMs')
  validatePositiveInteger(
    maxOutputChars,
    'maxOutputChars',
  )

  return {
    name: 'shell-tools',

    dependencies: ['tools'],

    setup(context) {
      const tools = context.get<ToolsService>('tools')

      return tools.register({
        name: 'run_command',
        risk: 'shell-high',
        riskFor: (args) =>
          classifyCommandRisk(args, rootDir),
        description:
          'Execute a shell command inside the workspace.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Shell command to execute.',
            },
            cwd: {
              type: 'string',
              description:
                'Working directory relative to the workspace root.',
            },
          },
          required: ['command'],
          additionalProperties: false,
        },

        async execute(args, signal) {
          const command = requireNonEmptyString(
            args,
            'command',
          )

          const requestedCwd =
            args.cwd === undefined
              ? '.'
              : requireNonEmptyString(args, 'cwd')

          const cwd = await resolveWorkspaceDirectory(
            rootDir,
            requestedCwd,
          )

          // cwd 的真实路径已经校验过；命令参数还需要单独检查，避免
          // `cat ../secret` 或 workspace 内指向外部的符号链接绕过限制。
          await assertCommandPathsInsideWorkspace(
            rootDir,
            cwd,
            command,
          )

          return executeCommand(
            command,
            cwd,
            timeoutMs,
            maxOutputChars,
            signal,
          )
        },
      })
    },
  }
}

/**
 * 默认 Shell 工具插件。
 */
export const shellToolsPlugin =
  createShellToolsPlugin()

/** Shell 词法扫描结果。 */
interface ParsedShellCommand {
  readonly tokens: readonly string[]
  readonly hasShellSyntax: boolean
  readonly valid: boolean
}

/** 将明确的只读命令与其他 Shell 命令分开。 */
function classifyCommandRisk(
  args: Record<string, unknown>,
  rootDir: string,
): 'shell-low' | 'shell-high' {
  const command = args.command
  if (typeof command !== 'string') return 'shell-high'

  const parsed = parseShellCommand(command)
  if (!parsed.valid || parsed.tokens.length === 0) {
    return 'shell-high'
  }

  // 只有引号外的操作符才是 Shell 语法。这样 `rg "foo|bar" src`
  // 不会因为正则表达式中的 | 被误判为管道。
  if (parsed.hasShellSyntax) return 'shell-high'

  const [executable, ...argumentsList] = parsed.tokens
  if (executable === undefined) return 'shell-high'

  // 通过 PATH 查找的 `ls` 可以进入低风险白名单；显式指定的可执行文件
  // 路径不属于这个白名单，避免把任意脚本伪装成只读命令。
  if (isLikelyPath(executable)) return 'shell-high'

  const commandName = normalizeCommandName(executable)
  if (isDangerousCommand(commandName, argumentsList)) {
    return 'shell-high'
  }

  const requestedCwd =
    typeof args.cwd === 'string' ? args.cwd : '.'
  if (
    pathCandidatesEscapeWorkspace(
      rootDir,
      requestedCwd,
      commandName,
      argumentsList,
    )
  ) {
    return 'shell-high'
  }

  const simpleReadCommands = new Set([
    'pwd',
    'ls',
    'dir',
    'cat',
    'head',
    'tail',
    'wc',
    'grep',
    'rg',
    'find',
    'git',
  ])
  if (!simpleReadCommands.has(commandName)) return 'shell-high'

  if (commandName === 'git') {
    const subcommand = findGitSubcommand(argumentsList)
    return subcommand === 'status' || subcommand === 'diff' || subcommand === 'log'
      ? 'shell-low'
      : 'shell-high'
  }

  return 'shell-low'
}

/**
 * 对命令做最小词法扫描。
 *
 * 这里不尝试实现 Shell 解析器，只识别会改变命令执行范围的语法。
 * 引号和反斜杠会保护其中的字符，避免把普通参数内容当成操作符。
 */
function parseShellCommand(command: string): ParsedShellCommand {
  const tokens: string[] = []
  let token = ''
  let tokenStarted = false
  let quote: 'single' | 'double' | undefined
  let hasShellSyntax = false
  let valid = true

  const pushToken = (): void => {
    if (!tokenStarted) return
    tokens.push(token)
    token = ''
    tokenStarted = false
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]

    if (quote === 'single') {
      if (character === "'") {
        quote = undefined
      } else {
        token += character
      }
      tokenStarted = true
      continue
    }

    if (quote === 'double') {
      if (character === '"') {
        quote = undefined
      } else if (character === '\\') {
        const next = command[index + 1]
        if (next === undefined) {
          valid = false
          break
        }
        token += next
        index += 1
      } else {
        // $ 和反引号在双引号中仍然会触发 Shell 展开。
        if (character === '$' || character === '`') {
          hasShellSyntax = true
        }
        token += character
      }
      tokenStarted = true
      continue
    }

    if (character === ' ' || character === '\t' || character === '\r') {
      pushToken()
      continue
    }

    if (character === '\n') {
      hasShellSyntax = true
      pushToken()
      continue
    }

    if (character === "'") {
      quote = 'single'
      tokenStarted = true
      continue
    }

    if (character === '"') {
      quote = 'double'
      tokenStarted = true
      continue
    }

    if (character === '\\') {
      const next = command[index + 1]
      if (next === undefined) {
        valid = false
        break
      }
      token += next
      tokenStarted = true
      index += 1
      continue
    }

    if (';&|><()`$'.includes(character)) {
      hasShellSyntax = true
      pushToken()
      continue
    }

    token += character
    tokenStarted = true
  }

  if (quote !== undefined) valid = false
  pushToken()

  return { tokens, hasShellSyntax, valid }
}

/** 规范化命令名；显式路径命令不会因此获得低风险资格。 */
function normalizeCommandName(executable: string): string {
  const lastSlash = Math.max(
    executable.lastIndexOf('/'),
    executable.lastIndexOf('\\'),
  )
  const name = executable.slice(lastSlash + 1).toLowerCase()
  return name.endsWith('.exe') ? name.slice(0, -4) : name
}

/** 判断命令名和子命令中是否出现明确的高风险操作。 */
function isDangerousCommand(
  commandName: string,
  argumentsList: readonly string[],
): boolean {
  const dangerousCommands = new Set([
    'rm',
    'rmdir',
    'del',
    'erase',
    'sudo',
    'su',
    'chmod',
    'chown',
    'mkfs',
    'dd',
    'shutdown',
    'reboot',
    'curl',
    'wget',
    'nc',
    'netcat',
    'ssh',
    'scp',
  ])
  if (dangerousCommands.has(commandName)) return true

  if (commandName === 'find') {
    return argumentsList.some((argument) =>
      new Set([
        '-delete',
        '-exec',
        '-execdir',
        '-ok',
        '-okdir',
      ]).has(argument.toLowerCase()),
    )
  }

  if (commandName === 'git') {
    const subcommand = findGitSubcommand(argumentsList)
    return subcommand === 'clean' || subcommand === 'reset'
  }

  return false
}

/** 找到 Git 的实际子命令，跳过常见的全局选项及其值。 */
function findGitSubcommand(
  argumentsList: readonly string[],
): string | undefined {
  const optionsWithValues = new Set([
    '-c',
    '-C',
    '--git-dir',
    '--work-tree',
    '--namespace',
  ])

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === undefined) continue
    if (optionsWithValues.has(argument)) {
      index += 1
      continue
    }
    if (argument.startsWith('-')) continue
    return argument.toLowerCase()
  }

  return undefined
}

/** 返回命令中可能代表文件或目录的参数。 */
function commandPathCandidates(
  commandName: string,
  argumentsList: readonly string[],
): readonly string[] {
  const positional = getPositionalArguments(argumentsList)

  if (
    commandName === 'cat' ||
    commandName === 'head' ||
    commandName === 'tail' ||
    commandName === 'wc' ||
    commandName === 'ls' ||
    commandName === 'dir'
  ) {
    return positional
  }

  if (commandName === 'find') {
    // -exec/-delete 等高风险表达式也可能携带文件参数，全部保留用于
    // 路径校验；风险判断仍由 isDangerousCommand 单独负责。
    return [
      ...positional.slice(0, 1),
      ...argumentsList.filter((argument) =>
        isLikelyPath(argument),
      ),
    ]
  }

  if (commandName === 'grep' || commandName === 'rg') {
    const hasFilesMode = argumentsList.some((argument) =>
      argument === '--files' ||
      argument === '--files-with-matches' ||
      argument === '--files-without-match',
    )
    const hasPatternOption = argumentsList.some((argument) =>
      argument === '-e' ||
      argument === '--regexp' ||
      argument.startsWith('--regexp='),
    )
    return hasFilesMode || hasPatternOption
      ? positional
      : positional.slice(1)
  }

  // Git 路径参数通常出现在 -- 之后；-C、--git-dir 等选项的值也要检查。
  if (commandName === 'git') {
    return getGitPathCandidates(argumentsList)
  }

  return argumentsList.flatMap((argument) => {
    const inlinePath = getInlinePathValue(argument)
    if (inlinePath !== undefined) return [inlinePath]
    return isLikelyPath(argument) ? [argument] : []
  })
}

/** 获取 Git 子命令后的路径参数和路径选项值。 */
function getGitPathCandidates(
  argumentsList: readonly string[],
): readonly string[] {
  const candidates: string[] = []
  const optionsWithValues = new Set([
    '-c',
    '-C',
    '--git-dir',
    '--work-tree',
    '--namespace',
  ])
  let subcommandSeen = false
  let skipNext = false

  for (const argument of argumentsList) {
    const inlinePath = getInlinePathValue(argument)
    if (inlinePath !== undefined) candidates.push(inlinePath)

    if (skipNext) {
      skipNext = false
      candidates.push(argument)
      continue
    }
    if (optionsWithValues.has(argument)) {
      skipNext = true
      continue
    }
    if (!subcommandSeen) {
      if (!argument.startsWith('-')) subcommandSeen = true
      continue
    }
    if (argument === '--') continue
    if (!argument.startsWith('-')) candidates.push(argument)
  }

  return candidates
}

/** 从参数中移除选项及其值，保留位置参数。 */
function getPositionalArguments(
  argumentsList: readonly string[],
): readonly string[] {
  const optionsWithValues = new Set([
    '-e',
    '--regexp',
    '-g',
    '--glob',
    '--type',
    '-t',
    '-f',
    '--file',
    '--ignore-file',
    '-C',
    '--color',
  ])
  const positional: string[] = []
  let skipNext = false

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === undefined) continue

    if (skipNext) {
      skipNext = false
      continue
    }
    if (argument === '--') {
      positional.push(...argumentsList.slice(index + 1))
      break
    }
    if (optionsWithValues.has(argument)) {
      skipNext = true
      continue
    }
    if (argument.startsWith('-')) continue
    positional.push(argument)
  }

  return positional
}

/** 判断参数是否是带路径值的常见选项。 */
function isPathOptionValue(option: string | undefined): boolean {
  return option === '-C' ||
    option === '--git-dir' ||
    option === '--work-tree'
}

/** 解析 `--option=/workspace/path` 形式的路径值。 */
function getInlinePathValue(
  argument: string,
): string | undefined {
  const separatorIndex = argument.indexOf('=')
  if (separatorIndex < 1) return undefined

  const value = argument.slice(separatorIndex + 1)
  if (!isLikelyPath(value)) return undefined

  return value
}

/** 判断字符串是否可能是路径，而不是普通文本或 URL。 */
function isLikelyPath(value: string): boolean {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return false
  if (value === '~' || value.startsWith('~/')) return true
  return value === '.' ||
    value === '..' ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.includes('/') ||
    value.includes('\\') ||
    /^[a-z]:[\\/]/i.test(value)
}

/** 判断命令路径是否在规范化 workspace 外。 */
function pathCandidatesEscapeWorkspace(
  rootDir: string,
  requestedCwd: string,
  commandName: string,
  argumentsList: readonly string[],
): boolean {
  if (requestedCwd.trim().length === 0) return true

  const cwd = resolve(rootDir, requestedCwd)
  if (!isInsideRoot(rootDir, cwd)) return true

  return commandPathCandidates(commandName, argumentsList).some((candidate) =>
    !isLikelyPathInsideRoot(cwd, rootDir, candidate),
  )
}

/** 使用规范化路径判断一个命令参数是否在 workspace 内。 */
function isLikelyPathInsideRoot(
  cwd: string,
  rootDir: string,
  candidate: string,
): boolean {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) return true
  if (candidate === '~' || candidate.startsWith('~/')) return false
  if (!isLikelyPath(candidate)) return true

  return isInsideRoot(rootDir, resolve(cwd, candidate))
}

/**
 * 在真正启动进程前校验命令中的文件参数。
 *
 * 风险判断是同步的，只能判断规范化路径；这里再检查已存在路径的真实
 * 路径，从而阻止 workspace 内指向 workspace 外的符号链接。
 *
 * @param rootDir - workspace 根目录。
 * @param cwd - 已校验的真实工作目录。
 * @param command - 待执行的 Shell 命令。
 */
async function assertCommandPathsInsideWorkspace(
  rootDir: string,
  cwd: string,
  command: string,
): Promise<void> {
  const parsed = parseShellCommand(command)
  if (!parsed.valid) {
    throw new Error('command contains an unterminated quote or escape')
  }

  const executable = parsed.tokens[0]
  if (executable === undefined) {
    throw new Error('command must not be empty')
  }

  const realRootDir = await realpath(rootDir)
  const commandName = normalizeCommandName(executable)

  for (const candidate of commandPathCandidates(
    commandName,
    parsed.tokens.slice(1),
  )) {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) continue
    if (candidate === '~' || candidate.startsWith('~/')) {
      throw new Error(
        `command path "${candidate}" may escape the workspace`,
      )
    }

    const targetPath = resolve(cwd, candidate)
    assertInsideRoot(realRootDir, targetPath)

    const realTargetPath = await realpathWithExistingAncestor(targetPath)
    assertInsideRoot(realRootDir, realTargetPath)
  }
}

/** 获取路径本身或其最近存在祖先的真实路径。 */
async function realpathWithExistingAncestor(
  targetPath: string,
): Promise<string> {
  let currentPath = targetPath

  while (true) {
    try {
      return await realpath(currentPath)
    } catch (error: unknown) {
      if (!isMissingPathError(error)) throw error

      const parentPath = dirname(currentPath)
      if (parentPath === currentPath) throw error
      currentPath = parentPath
    }
  }
}

/** 判断 realpath 失败是否只是因为路径尚不存在。 */
function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return 'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/**
 * 执行命令并收集结果。
 *
 * 非零退出码不会抛出异常，而是作为结果返回给模型。
 *
 * @param command - Shell 命令。
 * @param cwd - 工作目录。
 * @param timeoutMs - 超时时间。
 * @param maxOutputChars - 单个输出流的最大字符数。
 * @param signal - 取消当前命令的信号。
 * @returns 命令执行结果。
 */
function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let spawnError: string | undefined
    let cancellationError: Error | undefined
    let finished = false
    let timer: NodeJS.Timeout | undefined

    const appendOutput = (
      current: string,
      chunk: string,
      stream: 'stdout' | 'stderr',
    ): string => {
      const remaining = maxOutputChars - current.length

      if (remaining <= 0) {
        if (stream === 'stdout') {
          stdoutTruncated = true
        } else {
          stderrTruncated = true
        }

        return current
      }

      if (chunk.length > remaining) {
        if (stream === 'stdout') {
          stdoutTruncated = true
        } else {
          stderrTruncated = true
        }

        return current + chunk.slice(0, remaining)
      }

      return current + chunk
    }

    const finish = (
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null,
    ): void => {
      if (finished) {
        return
      }

      finished = true

      if (timer !== undefined) {
        clearTimeout(timer)
      }

      if (signal !== undefined) {
        signal.removeEventListener('abort', onAbort)
      }

      if (cancellationError !== undefined) {
        rejectResult(cancellationError)
        return
      }

      const status = timedOut
        ? 'timed_out'
        : spawnError !== undefined
          ? 'spawn_error'
          : exitSignal !== null
            ? 'signaled'
            : 'completed'
      const outputTruncated =
        stdoutTruncated || stderrTruncated

      const output = [
        `status: ${status}`,
        'cancelled: false',
        `exit_code: ${exitCode === null ? 'null' : exitCode}`,
        `timed_out: ${timedOut}`,
        `signal: ${exitSignal ?? 'none'}`,
        `stdout_truncated: ${stdoutTruncated}`,
        `stderr_truncated: ${stderrTruncated}`,
        `output_truncated: ${outputTruncated}`,
        'stdout:',
        stdout.length === 0 ? '(empty)' : stdout,
        stdoutTruncated ? '[stdout truncated]' : '',
        'stderr:',
        stderr.length === 0 ? '(empty)' : stderr,
        stderrTruncated ? '[stderr truncated]' : '',
        spawnError === undefined
          ? ''
          : `error: ${spawnError}`,
      ]
        .filter((line) => line.length > 0)
        .join('\n')

      resolveResult(output)
    }

    const onAbort = (): void => {
      cancellationError = getAbortError(signal)
      terminateProcessTree(child)
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    child.stdout?.on('data', (chunk: string) => {
      stdout = appendOutput(
        stdout,
        chunk,
        'stdout',
      )
    })

    child.stderr?.on('data', (chunk: string) => {
      stderr = appendOutput(
        stderr,
        chunk,
        'stderr',
      )
    })

    child.on('error', (error: Error) => {
      spawnError = error.message
      finish(null, null)
    })

    child.on('close', (exitCode, exitSignal) => {
      finish(exitCode, exitSignal)
    })

    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true })

      if (signal.aborted) {
        onAbort()
      }
    }

    timer = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child)
    }, timeoutMs)
  })
}

/** 终止 Shell 及其启动的子进程，避免只杀掉 shell 外壳。 */
function terminateProcessTree(
  child: ReturnType<typeof spawn>,
): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGTERM')
      return
    } catch {
      // 进程可能已经退出，此时继续尝试终止 shell 本身。
    }
  }

  child.kill('SIGTERM')
}

/** 获取工具取消时需要向 Agent Loop 传播的错误。 */
function getAbortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error('agent run cancelled')
}

/**
 * 将路径解析为 workspace 内的真实目录。
 *
 * @param rootDir - workspace 根目录。
 * @param requestedPath - 用户传入的路径。
 * @returns workspace 内的真实目录。
 */
async function resolveWorkspaceDirectory(
  rootDir: string,
  requestedPath: string,
): Promise<string> {
  const targetPath = resolve(rootDir, requestedPath)

  assertInsideRoot(rootDir, targetPath)

  const realRootDir = await realpath(rootDir)
  const realTargetPath = await realpath(targetPath)

  assertInsideRoot(realRootDir, realTargetPath)

  const targetStat = await stat(realTargetPath)

  if (!targetStat.isDirectory()) {
    throw new Error(
      `cwd "${requestedPath}" is not a directory`,
    )
  }

  return realTargetPath
}

/**
 * 确保路径没有离开 workspace。
 *
 * @param rootDir - workspace 根目录。
 * @param targetPath - 待检查路径。
 */
function assertInsideRoot(
  rootDir: string,
  targetPath: string,
): void {
  if (!isInsideRoot(rootDir, targetPath)) {
    throw new Error(
      `path "${targetPath}" is outside the workspace`,
    )
  }
}

/** 使用规范化路径判断目标是否位于根目录内。 */
function isInsideRoot(
  rootDir: string,
  targetPath: string,
): boolean {
  const relativePath = relative(rootDir, targetPath)

  return relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
}

/**
 * 获取非空字符串参数。
 *
 * @param args - 工具参数。
 * @param name - 参数名称。
 * @returns 参数字符串。
 */
function requireNonEmptyString(
  args: ToolArguments,
  name: string,
): string {
  const value = args[name]

  if (
    typeof value !== 'string' ||
    value.trim().length === 0
  ) {
    throw new Error(
      `argument "${name}" must be a non-empty string`,
    )
  }

  return value
}

/**
 * 校验正整数配置。
 *
 * @param value - 待校验的值。
 * @param name - 配置名称。
 */
function validatePositiveInteger(
  value: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} must be a positive integer`,
    )
  }
}
