/**
 * 粘贴安全提示 + 剪贴板读写。
 *
 * 为什么粘贴要拦一下：终端里一次粘贴多行 = 立刻执行多条命令（`rm -rf` 之类的经典事故）。
 * 真实终端模拟器（iTerm2、Termius、VS Code）都做这层确认，这里只做「行数 + 是否带回车」判定，
 * 不做内容审核（审核用户自己的命令既越界也不可靠）。
 *
 * 剪贴板：Electron 沙箱渲染进程里 `navigator.clipboard` 有时不可用（权限/焦点），
 * 所以保留 `textarea + execCommand('copy')` 兜底，失败返回 false 由 UI 提示，不静默。
 */

export interface PasteInspection {
  /** 归一化后的文本（CRLF → LF） */
  text: string
  /** 会被当成「一条命令」执行的行数（去掉末尾空行） */
  lineCount: number
  charCount: number
  /** 末尾带换行 = 粘贴后立刻执行最后一条命令 */
  hasTrailingNewline: boolean
  /** 是否需要确认（多行 或 末尾带回车） */
  needsConfirm: boolean
  hasCarriageReturns: boolean
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function inspectPaste(rawText: string): PasteInspection {
  const text = normalizeNewlines(rawText)
  const hasTrailingNewline = text.endsWith('\n')
  const segments = text.split('\n')
  const effectiveSegments = hasTrailingNewline ? segments.slice(0, -1) : segments
  // 全空白行不参与「会执行几条命令」的计数：但末尾带回车时至少算一次执行
  const nonEmpty = effectiveSegments.filter((segment) => segment.trim().length > 0)
  const lineCount = hasTrailingNewline ? Math.max(nonEmpty.length, 1) : nonEmpty.length
  return {
    text,
    lineCount,
    charCount: text.length,
    hasTrailingNewline,
    needsConfirm: lineCount > 1 || hasTrailingNewline,
    hasCarriageReturns: /\r/.test(rawText)
  }
}

/** 直接写 clipboard；返回是否成功（失败时 UI 应该提示而不是假装复制了） */
export async function writeClipboardText(text: string): Promise<boolean> {
  if (text.length === 0) return false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到下面的兜底
  }
  if (typeof document === 'undefined') return false
  try {
    const holder = document.createElement('textarea')
    holder.value = text
    holder.setAttribute('readonly', 'true')
    holder.style.position = 'fixed'
    holder.style.opacity = '0'
    document.body.appendChild(holder)
    holder.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(holder)
    return ok
  } catch {
    return false
  }
}

/** 读 clipboard；拿不到（权限/空）返回空串 */
export async function readClipboardText(): Promise<string> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      return await navigator.clipboard.readText()
    }
  } catch {
    // Electron 里 readText 可能被拒，退回空串（调用方据此提示用户用 ⌘V）
  }
  return ''
}
