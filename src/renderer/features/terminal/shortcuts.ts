import type { AppPlatform } from '@shared'

/**
 * 快捷键 → 动作的映射表（纯函数，单测直接喂键盘事件对象）。
 *
 * 三条硬规则，踩过才知道为什么要写死在代码里：
 * 1. **只抢「主修饰键」组合**：mac 是 ⌘、其它平台是 Ctrl。终端里 Ctrl+C/Ctrl+D/Ctrl+L/Ctrl+R
 *    是 shell 的命脉，任何"顺手"的拦截都会让用户以为键盘坏了。
 * 2. mac 上 Ctrl+X 一律放行（连 Ctrl+Tab 都只做页签切换这一个例外，因为那是 macOS 的既定习惯）。
 * 3. 焦点在输入框（搜索框、快速连接表单）里时不抢任何键，否则搜索框里打不出字。
 */

export interface KeyStroke {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

export interface ShortcutContext extends KeyStroke {
  platform: AppPlatform
  /** 焦点是否在 input/textarea/contenteditable 里 */
  inEditable?: boolean
}

export type TerminalAction =
  | { type: 'new-tab' }
  | { type: 'close-tab' }
  | { type: 'next-tab' }
  | { type: 'previous-tab' }
  | { type: 'activate-tab'; index: number }
  | { type: 'zoom-in' }
  | { type: 'zoom-out' }
  | { type: 'zoom-reset' }
  | { type: 'find' }
  | { type: 'clear' }
  | { type: 'copy-all' }
  | { type: 'paste' }

/** 主修饰键：darwin = ⌘，其它 = Ctrl */
export function isPrimaryModifier(event: KeyStroke, platform: AppPlatform): boolean {
  return platform === 'darwin' ? event.metaKey === true : event.ctrlKey === true
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase()
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

export function resolveShortcut(context: ShortcutContext): TerminalAction | null {
  if (context.inEditable) return null
  if (context.altKey) return null

  const key = normalizeKey(context.key)
  const primary = isPrimaryModifier(context, context.platform)

  // Ctrl+Tab / Ctrl+Shift+Tab：所有平台都切成页签（mac 上 ⌃⇥ 也是既定习惯）
  if (context.ctrlKey && key === 'tab') {
    return context.shiftKey ? { type: 'previous-tab' } : { type: 'next-tab' }
  }

  if (!primary) return null

  // mac 上 ⌃ 组合（非 ⌘）必须原样进 shell；非 mac 上 ⌘ 组合交给系统
  if (context.platform === 'darwin') {
    if (context.ctrlKey) return null
  } else if (context.metaKey) {
    return null
  }

  switch (key) {
    case 't':
      return { type: 'new-tab' }
    case 'w':
      return { type: 'close-tab' }
    case ']':
    case 'pagedown':
      return { type: 'next-tab' }
    case '[':
    case 'pageup':
      return { type: 'previous-tab' }
    case 'f':
      return { type: 'find' }
    case 'k':
      return { type: 'clear' }
    case '=':
    case '+':
      return { type: 'zoom-in' }
    case '-':
      return { type: 'zoom-out' }
    case '0':
      return { type: 'zoom-reset' }
    case 'c':
      // ⌘⇧C = 复制全部；⌘C 有选区时让浏览器原生复制，不抢
      return context.shiftKey ? { type: 'copy-all' } : null
    case 'v':
      // ⌘⇧V = 读剪贴板并走多行安全确认；⌘V 走原生 paste 事件
      return context.shiftKey ? { type: 'paste' } : null
    default:
      break
  }

  if ((DIGITS as readonly string[]).includes(key)) {
    return { type: 'activate-tab', index: Number.parseInt(key, 10) }
  }

  return null
}

/** 事件目标是否是可输入元素（决定要不要让快捷键失效） */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false
  const element = target as HTMLElement
  const tag = element.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return element.isContentEditable === true
}
