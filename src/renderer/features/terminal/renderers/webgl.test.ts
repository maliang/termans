import { describe, expect, it } from 'vitest'
import { attachRenderer, type WebglAddonLike } from './webgl'

/**
 * WebGL 渲染回退单测。
 *
 * 这台机器（和大多数 CI）不一定有 WebGL2，但**回退路径必须永远可用**：
 * 装载失败 → DOM；运行中 context lost → DOM，且终端内容不重建。
 * 假 addon 就能把这两条钉死，不需要真的 GPU。
 */

function createFakeAddon(options: { throwOnLoad?: boolean } = {}) {
  let lossListener: (() => void) | null = null
  const disposals: number[] = []
  const addon: WebglAddonLike = {
    onContextLoss: (listener) => {
      lossListener = listener
      return {
        dispose: () => {
          lossListener = null
        }
      }
    },
    dispose: () => {
      disposals.push(1)
    }
  }
  return {
    addon,
    disposals,
    fireContextLoss: () => lossListener?.(),
    throwOnLoad: options.throwOnLoad === true
  }
}

describe('attachRenderer', () => {
  it('没有 WebGL 加载器时直接用 DOM', () => {
    const attachment = attachRenderer({ loadAddon: () => {} }, null)
    expect(attachment.kind).toBe('dom')
    attachment.dispose()
  })

  it('WebGL 成功装载时 kind = webgl', () => {
    const fake = createFakeAddon()
    const loaded: WebglAddonLike[] = []
    const attachment = attachRenderer({ loadAddon: (addon) => loaded.push(addon) }, () => fake.addon)
    expect(attachment.kind).toBe('webgl')
    expect(loaded).toEqual([fake.addon])
    attachment.dispose()
  })

  it('装载抛错（无 GPU / 远程桌面）→ 回退 DOM 并回调一次', () => {
    const errors: unknown[] = []
    const attachment = attachRenderer(
      {
        loadAddon: () => {
          throw new Error('WebGL2 not available')
        }
      },
      () => createFakeAddon().addon,
      (error) => errors.push(error)
    )
    expect(attachment.kind).toBe('dom')
    expect(errors).toHaveLength(1)
    expect(() => attachment.dispose()).not.toThrow()
  })

  it('运行中 context lost → kind 变 dom 且 addon 被释放', () => {
    const fake = createFakeAddon()
    const fallbacks: unknown[] = []
    const attachment = attachRenderer(
      { loadAddon: () => {} },
      () => fake.addon,
      (error) => fallbacks.push(error)
    )
    expect(attachment.kind).toBe('webgl')
    fake.fireContextLoss()
    expect(attachment.kind).toBe('dom')
    expect(fake.disposals.length).toBeGreaterThanOrEqual(1)
    expect(fallbacks.some((error) => String(error).includes('context lost'))).toBe(true)
    // 已经因丢失释放过，再 dispose 不能抛
    expect(() => attachment.dispose()).not.toThrow()
  })

  it('dispose 幂等：重复调用只释放一次', () => {
    const fake = createFakeAddon()
    const attachment = attachRenderer({ loadAddon: () => {} }, () => fake.addon)
    attachment.dispose()
    attachment.dispose()
    expect(fake.disposals).toHaveLength(1)
  })
})
