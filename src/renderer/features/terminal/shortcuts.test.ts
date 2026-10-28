import { describe, expect, it } from 'vitest'
import { isEditableTarget, isPrimaryModifier, resolveShortcut, type ShortcutContext } from './shortcuts'

/**
 * 快捷键映射单测（验收矩阵里的「快捷键映射」）。
 *
 * 这组用例的价值全在**负向**：真正会毁掉体验的不是「⌘T 没新建页签」，
 * 而是「Ctrl+C 被拦了」——用户会以为键盘坏了，然后去重装客户端。
 */

const mac = (key: string, extra: Partial<ShortcutContext> = {}): ShortcutContext => ({
  key,
  platform: 'darwin',
  ...extra
})

const win = (key: string, extra: Partial<ShortcutContext> = {}): ShortcutContext => ({
  key,
  platform: 'win32',
  ...extra
})

describe('isPrimaryModifier', () => {
  it('darwin 认 ⌘，其它平台认 Ctrl', () => {
    expect(isPrimaryModifier({ key: 't', metaKey: true }, 'darwin')).toBe(true)
    expect(isPrimaryModifier({ key: 't', ctrlKey: true }, 'darwin')).toBe(false)
    expect(isPrimaryModifier({ key: 't', ctrlKey: true }, 'linux')).toBe(true)
    expect(isPrimaryModifier({ key: 't', metaKey: true }, 'win32')).toBe(false)
  })
})

describe('页签快捷键', () => {
  it('⌘T 新建、⌘W 关闭（win/linux 用 Ctrl）', () => {
    expect(resolveShortcut(mac('t', { metaKey: true }))).toEqual({ type: 'new-tab' })
    expect(resolveShortcut(mac('w', { metaKey: true }))).toEqual({ type: 'close-tab' })
    expect(resolveShortcut(win('t', { ctrlKey: true }))).toEqual({ type: 'new-tab' })
    expect(resolveShortcut(win('W', { ctrlKey: true }))).toEqual({ type: 'close-tab' })
  })

  it('⌘1..⌘9 → 第 N 个页签（9 由 store 解释成最后一个）', () => {
    expect(resolveShortcut(mac('1', { metaKey: true }))).toEqual({ type: 'activate-tab', index: 1 })
    expect(resolveShortcut(mac('9', { metaKey: true }))).toEqual({ type: 'activate-tab', index: 9 })
    expect(resolveShortcut(mac('0', { metaKey: true }))).toEqual({ type: 'zoom-reset' })
  })

  it('Ctrl+Tab / Ctrl+Shift+Tab 全平台切页签（mac 上也是 ⌃⇥）', () => {
    expect(resolveShortcut(mac('Tab', { ctrlKey: true }))).toEqual({ type: 'next-tab' })
    expect(resolveShortcut(mac('Tab', { ctrlKey: true, shiftKey: true }))).toEqual({ type: 'previous-tab' })
    expect(resolveShortcut(win('Tab', { ctrlKey: true }))).toEqual({ type: 'next-tab' })
  })

  it('⌘] / ⌘[ 与 PageUp/PageDown 也能切', () => {
    expect(resolveShortcut(mac(']', { metaKey: true }))).toEqual({ type: 'next-tab' })
    expect(resolveShortcut(mac('[', { metaKey: true }))).toEqual({ type: 'previous-tab' })
    expect(resolveShortcut(mac('PageDown', { metaKey: true }))).toEqual({ type: 'next-tab' })
    expect(resolveShortcut(mac('PageUp', { metaKey: true }))).toEqual({ type: 'previous-tab' })
  })
})

describe('终端动作快捷键', () => {
  it('⌘F 搜索、⌘K 清屏', () => {
    expect(resolveShortcut(mac('f', { metaKey: true }))).toEqual({ type: 'find' })
    expect(resolveShortcut(mac('k', { metaKey: true }))).toEqual({ type: 'clear' })
  })

  it('字号：⌘+ / ⌘- / ⌘0（含 + 的 shift 形态与 = 键）', () => {
    expect(resolveShortcut(mac('=', { metaKey: true }))).toEqual({ type: 'zoom-in' })
    expect(resolveShortcut(mac('+', { metaKey: true }))).toEqual({ type: 'zoom-in' })
    expect(resolveShortcut(mac('-', { metaKey: true }))).toEqual({ type: 'zoom-out' })
    expect(resolveShortcut(mac('0', { metaKey: true }))).toEqual({ type: 'zoom-reset' })
  })

  it('复制全部只认 ⌘⇧C：不带 shift 的 ⌘C 留给原生复制', () => {
    expect(resolveShortcut(mac('c', { metaKey: true, shiftKey: true }))).toEqual({ type: 'copy-all' })
    expect(resolveShortcut(mac('c', { metaKey: true }))).toBeNull()
  })

  it('粘贴确认只认 ⌘⇧V：不带 shift 的 ⌘V 留给原生 paste 事件', () => {
    expect(resolveShortcut(mac('v', { metaKey: true, shiftKey: true }))).toEqual({ type: 'paste' })
    expect(resolveShortcut(mac('v', { metaKey: true }))).toBeNull()
  })
})

describe('不该抢的键（负向，最重要）', () => {
  it('mac 上 ⌃C/⌃D/⌃L/⌃R 全部原样进 shell', () => {
    for (const key of ['c', 'd', 'l', 'r', 'a', 'e']) {
      expect(resolveShortcut(mac(key, { ctrlKey: true }))).toBeNull()
    }
  })

  it('非 mac 上 ⌘ 组合交给系统', () => {
    expect(resolveShortcut(win('t', { metaKey: true }))).toBeNull()
    expect(resolveShortcut({ key: 't', platform: 'linux', metaKey: true })).toBeNull()
  })

  it('裸键与普通字符一律不拦', () => {
    expect(resolveShortcut(mac('t'))).toBeNull()
    expect(resolveShortcut(mac('Enter'))).toBeNull()
    expect(resolveShortcut(win('Backspace'))).toBeNull()
  })

  it('Alt 组合放行（mac 用来打特殊字符，其它平台给 shell）', () => {
    expect(resolveShortcut(mac('b', { metaKey: true, altKey: true }))).toBeNull()
    expect(resolveShortcut(win('b', { ctrlKey: true, altKey: true }))).toBeNull()
  })

  it('焦点在输入框里时一个都不拦（否则搜索框打不出字）', () => {
    expect(resolveShortcut(mac('f', { metaKey: true, inEditable: true }))).toBeNull()
    expect(resolveShortcut(mac('w', { metaKey: true, inEditable: true }))).toBeNull()
    expect(resolveShortcut(mac('Tab', { ctrlKey: true, inEditable: true }))).toBeNull()
  })
})

describe('isEditableTarget', () => {
  // 单测跑在 node 环境（没有 DOM），所以这里用结构相同的假对象，
  // 判据就是函数真实读的两个字段：tagName 与 isContentEditable
  const fake = (tagName: string, isContentEditable = false): EventTarget =>
    ({ tagName, isContentEditable }) as unknown as EventTarget

  it('识别 input/textarea/select 与 contenteditable', () => {
    expect(isEditableTarget(fake('INPUT'))).toBe(true)
    expect(isEditableTarget(fake('TEXTAREA'))).toBe(true)
    expect(isEditableTarget(fake('SELECT'))).toBe(true)
    expect(isEditableTarget(fake('DIV'))).toBe(false)
    expect(isEditableTarget(fake('DIV', true))).toBe(true)
    expect(isEditableTarget(null)).toBe(false)
  })
})
