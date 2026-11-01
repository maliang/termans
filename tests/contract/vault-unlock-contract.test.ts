import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { IPC_CHANNELS, IPC_INVOKE_CHANNELS, unlockFailureClassSchema } from '@shared'

/**
 * 渲染层契约对账（r3 AC-1..AC-4 / AC-10..AC-18 的静态守卫）。
 *
 * 为什么是「读源码对账」而不是挂载 React：`vitest.config.ts` 的 `environment` 是 `node`，
 * 项目里没有 jsdom / @testing-library，为一条守卫引入整套 DOM 运行时是不划算的。
 * 这里守的是**契约面**：DOM 锚点、i18n 键、IPC 通道、禁词根、既有 testid 不回归。
 * 真正的行为验证在 `e2e/unlock-lockout.spec.ts`（T12 拥有），这里只负责让「锚点悄悄消失」
 * 变成一次红 —— 假绿的典型形态是选择器指向不存在的 testid，失败表现不是红而是永远绿。
 */

const repoRoot = resolve(__dirname, '../..')
const screenPath = resolve(repoRoot, 'src/renderer/features/unlock/UnlockScreen.tsx')
const noticePath = resolve(repoRoot, 'src/renderer/features/unlock/VaultNoticeBar.tsx')
const apiPath = resolve(repoRoot, 'src/renderer/features/vault/api.ts')
const i18nPath = resolve(repoRoot, 'src/renderer/features/vault/i18n.ts')
const specPath = resolve(repoRoot, 'e2e/unlock-lockout.spec.ts')

const screen = readFileSync(screenPath, 'utf8')
const notice = readFileSync(noticePath, 'utf8')
const api = readFileSync(apiPath, 'utf8')
const i18n = readFileSync(i18nPath, 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(t|j)sx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** src/renderer 里声明的 testid（`data-testid="x"` 与 `<DiagRow testId="x">` 两种写法都算） */
function declaredTestIds(): string[] {
  const values: string[] = []
  for (const file of walk(resolve(repoRoot, 'src/renderer'))) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/(?:data-testid|testId)=(?:"([^"]*)"|\{([^}]*)\})/g)) {
      values.push((match[1] ?? match[2] ?? '').trim())
    }
  }
  return values
}

const MODES = [
  'unlock',
  'create',
  'recover',
  'recovery-saved',
  'new-library-confirm',
  'new-library-create',
  'new-library-created'
] as const

/** r3 新增的 testid（DESIGN §4.4） */
const NEW_TEST_IDS = [
  'library-switcher',
  'library-list',
  'library-row',
  'create-library-entry',
  'create-library-confirm',
  'create-library-confirm-points',
  'new-library-name',
  'new-library-continue',
  'new-library-cancel',
  'new-library-submit',
  'unlock-attribution',
  'unlock-throttle-countdown',
  'unlock-diag-toggle',
  'unlock-diag',
  'diag-created-at',
  'diag-last-unlocked',
  'diag-last-synced',
  'diag-revision',
  'diag-kdf',
  'diag-fingerprint',
  'unlock-progress',
  'variant-notice',
  'variant-notice-dismiss'
] as const

/** AC-18：既有锚点不许改名（e2e 的 12 个既有 spec 都按这些字面量取元素） */
const LEGACY_TEST_IDS = [
  'unlock-screen',
  'passphrase-input',
  'passphrase-repeat',
  'create-vault',
  'unlock-vault',
  'recover-vault',
  'recovery-code-input',
  'preview-mode',
  'unlock-recovery-code',
  'weak-passphrase-warning'
] as const

/** r3 新增的 i18n 键（DESIGN §4.3；en 与 zh-CN 必须同批各一份） */
const NEW_KEYS = [
  'unlock.library.current',
  'unlock.library.badge',
  'unlock.library.default',
  'unlock.library.switch',
  'unlock.library.list',
  'unlock.library.createdAt',
  'unlock.library.lastUnlocked',
  'unlock.library.switchedTo',
  'unlock.attr.badTitle',
  'unlock.attr.badBody',
  'unlock.attr.checksTitle',
  'unlock.attr.checks1',
  'unlock.attr.checks2',
  'unlock.attr.checks3',
  'unlock.attr.throttleTitle',
  'unlock.attr.throttleBody',
  'unlock.attr.throttleWait',
  'unlock.attr.slotTitle',
  'unlock.attr.slotBody',
  'unlock.attr.slotLastUnlocked',
  'unlock.attr.corruptTitle',
  'unlock.attr.corruptBody',
  'unlock.attr.corruptDoc',
  'unlock.attr.retry',
  'unlock.diag.toggle',
  'unlock.diag.createdAt',
  'unlock.diag.lastUnlocked',
  'unlock.diag.lastSynced',
  'unlock.diag.revision',
  'unlock.diag.kdf',
  'unlock.diag.fingerprint',
  'unlock.diag.note',
  'unlock.diag.unknown',
  'unlock.diag.fingerprintUnknown',
  'unlock.newLibrary.title',
  'unlock.newLibrary.entry',
  'unlock.newLibrary.subtitle',
  'unlock.newLibrary.lead',
  'unlock.newLibrary.point1',
  'unlock.newLibrary.point2',
  'unlock.newLibrary.point3',
  'unlock.newLibrary.nameLabel',
  'unlock.newLibrary.namePlaceholder',
  'unlock.newLibrary.defaultName',
  'unlock.newLibrary.cancel',
  'unlock.newLibrary.continue',
  'unlock.newLibrary.submit',
  'unlock.newLibrary.exists',
  'unlock.variant.progress',
  'unlock.variant.hit',
  'unlock.variant.name.nfkc',
  'unlock.variant.name.trim',
  'unlock.variant.name.stripZeroWidth',
  'unlock.variant.dismiss'
] as const

/** AC-17：任何「重置 / 清空 / 删除 / 绕过 / 覆盖」语义的入口都不许出现 */
const FORBIDDEN_ROOTS = /reset|clear|delete|wipe|bypass|overwrite/i

describe('解锁屏七态（AC-10 / AC-16）', () => {
  it('Mode 联合类型声明了七种态，且新建库不复用 create', () => {
    for (const mode of MODES) {
      expect(screen, `Mode 缺少 ${mode}`).toContain(`'${mode}'`)
    }
    // 「新建库」必须是独立态：复用 create 会在 uninitialized 下冒出第二个创建入口
    const declaration = screen.slice(screen.indexOf('type Mode ='), screen.indexOf('const pad2'))
    expect(declaration).toContain("'new-library-confirm'")
    expect(declaration).toContain("'new-library-create'")
  })

  it('兜底入口 create-library-entry 只在 locked 渲染（AC-10）', () => {
    expect(screen).toMatch(/unlockMode && status\?\.state === 'locked'/)
  })

  it('恢复码页不渲染 footer、并显式吞掉 Esc（AC-16）', () => {
    // footer 的守卫：savingRecovery 时整块不渲染（「继续以预览模式使用」就是那个逃逸出口）
    expect(screen).toMatch(/savingRecovery \? null : \(\s*<footer/)
    expect(screen).toContain("addEventListener('keydown', swallow, true)")
    // 「恢复码未确认」必须在**建库 IPC 之前**挂上：主进程建库成功会先广播
    // vault:state-changed（state=unlocked），那一帧若标志还是 false，外壳立刻接管、
    // 恢复码页一闪而过（真机复现过：放在 await 之后写等于没写）。
    const pendingAt = screen.indexOf('setRecoveryPending(true)')
    const createAt = screen.indexOf('api.createVault(passphrase)')
    const savedAt = screen.indexOf("setMode('recovery-saved')")
    expect(pendingAt, '必须调用 setRecoveryPending(true)').toBeGreaterThan(-1)
    expect(createAt, '必须调用 api.createVault').toBeGreaterThan(-1)
    expect(pendingAt, '恢复码未确认必须早于建库 IPC').toBeLessThan(createAt)
    expect(createAt, '建库成功后才进恢复码页').toBeLessThan(savedAt)
    // 失败路径必须撤掉标志，否则用户会被锁在一个永远不来的等待里
    expect(screen).toMatch(/setRecoveryPending\(false\)/)
  })

  it('七态机的当前态挂成 data-mode 属性（e2e 判态不靠猜按钮文案）', () => {
    expect(screen).toContain('data-mode={mode}')
    expect(screen).toContain('data-vault-state={status?.state')
  })
})

describe('四类归因块（AC-1 / AC-2）', () => {
  it('data-class 的取值域与冻结契约完全一致', () => {
    expect(unlockFailureClassSchema.options).toEqual([
      'bad-passphrase',
      'throttled',
      'slot-record-mismatch',
      'corrupt'
    ])
    expect(screen).toContain('data-testid="unlock-attribution"')
    expect(screen).toContain('data-class={failure.class}')
  })

  it('四类各有专属图标，红色只给 corrupt', () => {
    for (const icon of ['CircleAlert', 'Timer', 'HardDrive', 'FileX']) {
      expect(screen, `归因块缺少图标 ${icon}`).toContain(`<${icon} size={14}`)
    }
    // tone 映射：corrupt → error，slot-record-mismatch → notice，其余 warn
    expect(screen).toContain("if (cls === 'corrupt') return 'error'")
    expect(screen).toContain("if (cls === 'slot-record-mismatch') return 'notice'")
  })

  it('throttled 一定有倒计时锚点（AC-1：限流必须有可观测的等待时长）', () => {
    expect(screen).toContain('data-testid="unlock-throttle-countdown"')
    expect(screen).toContain('retryAfterSeconds')
  })

  it('归因只读 status.unlockFailure，不拿 error reason 反推 class', () => {
    // 渲染层拿 reason 猜 class 会让四分类出现第二个实现（DESIGN §7 第 2 条）
    expect(screen).not.toMatch(/error\s*===\s*'bad-passphrase'/)
    expect(screen).not.toMatch(/errorReason\([^)]*\)\s*===\s*'slot-record-mismatch'/)
  })
})

describe('证据区六项（AC-3 / AC-4）', () => {
  it('六个诊断锚点全部声明', () => {
    for (const id of [
      'diag-created-at',
      'diag-last-unlocked',
      'diag-last-synced',
      'diag-revision',
      'diag-kdf',
      'diag-fingerprint'
    ]) {
      expect(screen, `诊断区缺少 ${id}`).toContain(`testId="${id}"`)
    }
    expect(screen).toContain('data-testid="unlock-diag-toggle"')
    expect(screen).toContain('data-testid="unlock-diag"')
  })

  it('诊断区永不渲染路径 / 主机名 / 口令（AC-3）', () => {
    const start = screen.indexOf('function VaultDiagnostics')
    expect(start).toBeGreaterThan(0)
    // 只取这一个函数体（到第一个顶格 `}` 为止），不要把下面解锁屏的注释一起算进来
    const block = screen.slice(start, screen.indexOf('\n}\n', start))
    expect(block.length).toBeGreaterThan(200)
    for (const forbidden of ['repoDir', 'localDir', 'remoteUrl', 'hostname', 'passphrase']) {
      expect(block, `诊断区不许出现 ${forbidden}`).not.toContain(forbidden)
    }
    expect(block).not.toMatch(/\/Users|\/home|[A-Za-z]:\\/)
  })

  it('无记录显示「未知」而不是 0 / 当前时间（AC-4）', () => {
    expect(screen).toContain('slotFingerprint ?? t(')
    expect(screen).toContain('fingerprintUnknown')
    // stamp() 必须把 null / 非法值都归成 null，让调用方统一落到 unknown
    expect(screen).toMatch(/function stamp\(value: string \| null\): string \| null \{\s*if \(value === null\) return null/)
  })
})

describe('多库切换与新建库（AC-12 / AC-13 / AC-14 / AC-15）', () => {
  it('1 只库只给只读行，≥2 只库才给 select + 列表', () => {
    expect(screen).toContain('libraries.length === 1')
    expect(screen).toContain('data-testid="library-switcher"')
    // e2e 直接读 `library-list` 的 `.open`，所以它必须是 <details> 本体
    expect(screen).toMatch(/<details[^>]*data-testid="library-list"/)
    expect(screen).toContain('data-testid="library-row"')
    expect(screen).toContain("data-current={library.isCurrent ? 'true' : 'false'}")
  })

  it('新建库三态齐全，确认页是三句编号列表（AC-15）', () => {
    expect(screen).toContain('data-testid="create-library-confirm"')
    expect(screen).toContain('data-testid="create-library-confirm-points"')
    const list = screen.slice(
      screen.indexOf('data-testid="create-library-confirm-points"'),
      screen.indexOf('data-testid="new-library-continue"')
    )
    expect(list.match(/<li>/g)?.length, '确认页必须恰好三句').toBe(3)
    // 二次确认不许用 window.confirm：它只能放一行，三句话一句都省不得
    expect(screen).not.toContain('window.confirm')
  })

  it('切库会清空屏上的口令输入（AC-12：两库互不自动解锁）', () => {
    const start = screen.indexOf('async function onSwitch')
    const block = screen.slice(start, screen.indexOf('const creating ='))
    expect(block).toContain('resetInputs()')
  })

  it('重名冲突走行内错误而不是弹窗（AC-14）', () => {
    expect(screen).toContain('unlock.newLibrary.exists')
    expect(screen).toContain('data-testid="new-library-submit"')
    expect(screen).toContain('ts-unlock__inline-error')
  })

  it('新库「记住本机」默认不勾（新建库调用方固定 false）', () => {
    expect(screen).toContain('rememberWithKeychain: false')
  })
})

describe('testid 契约（AC-18 + 禁词根）', () => {
  it('新增 testid 全部能在 src/renderer 找到声明', () => {
    const declared = declaredTestIds()
    const missing = NEW_TEST_IDS.filter((id) => !declared.some((value) => value.includes(id)))
    expect(missing, `这些 testid 没有落进 UI：\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('既有 testid 一个都不许改名或消失（AC-18）', () => {
    const declared = declaredTestIds()
    const missing = LEGACY_TEST_IDS.filter((id) => !declared.some((value) => value.includes(id)))
    expect(missing, `既有锚点被改动：\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('新增 testid 与 i18n 键都不含禁用词根（AC-17）', () => {
    for (const id of NEW_TEST_IDS) {
      expect(FORBIDDEN_ROOTS.test(id), `testid ${id} 含禁用词根`).toBe(false)
    }
    for (const key of NEW_KEYS) {
      expect(FORBIDDEN_ROOTS.test(key), `i18n 键 ${key} 含禁用词根`).toBe(false)
    }
  })

  it('自检：虚构 testid 判 false（证明扫描不是恒真）', () => {
    const declared = declaredTestIds()
    expect(declared.some((value) => value.includes('unlock-attribution-nope'))).toBe(false)
    expect(declared.length).toBeGreaterThan(20)
  })
})

describe('i18n 与 IPC 契约', () => {
  it('新增 key 在 en 与 zh-CN 两段各出现一次', () => {
    for (const key of NEW_KEYS) {
      const hits = i18n.split(`'${key}'`).length - 1
      expect(hits, `${key} 必须在 en 与 zh-CN 各一份（zhCN 类型是 Record<keyof typeof en, string>）`).toBe(2)
    }
  })

  it('三条多库通道同时存在于通道表与 api 薄封装里', () => {
    expect(IPC_CHANNELS.vault.libraries).toBe('vault:libraries')
    expect(IPC_CHANNELS.vault.libraryCreate).toBe('vault:library-create')
    expect(IPC_CHANNELS.vault.librarySwitch).toBe('vault:library-switch')
    for (const channel of ['vault:libraries', 'vault:library-create', 'vault:library-switch']) {
      expect(IPC_INVOKE_CHANNELS, `${channel} 不在 IPC_INVOKE_CHANNELS 里`).toContain(channel)
      expect(api, `api.ts 没有调用 ${channel}`).toContain(`'${channel}'`)
    }
  })

  it('api.ts 不调用契约外的通道（写错通道 = 首次调用就崩）', () => {
    const used = [...api.matchAll(/call\('([^']+)'/g)].map((match) => match[1])
    const dangling = used.filter((channel) => !IPC_INVOKE_CHANNELS.includes(channel as never))
    expect(dangling, `这些通道在 IPC_INVOKE_MAP 里不存在：\n  ${dangling.join('\n  ')}`).toEqual([])
  })

  it('告知条走 unlock.variant.* 且不运行时拼变体名', () => {
    expect(notice).toContain('data-testid="variant-notice"')
    expect(notice).toContain('data-testid="variant-notice-dismiss"')
    expect(notice).toContain('unlock.variant.hit')
    for (const key of ['unlock.variant.name.nfkc', 'unlock.variant.name.trim', 'unlock.variant.name.stripZeroWidth']) {
      expect(notice, `告知条缺少变体名 ${key}`).toContain(key)
    }
  })
})

describe('e2e 锚点对账（unlock-lockout.spec.ts）', () => {
  it('spec 里每个 getByTestId 字面量都能在 src/renderer 找到声明', () => {
    if (!existsSync(specPath)) {
      // T12 的 spec 尚未落盘时跳过（它不是本任务的产物），但不能静默恒绿
      expect(existsSync(specPath)).toBe(false)
      return
    }
    const spec = readFileSync(specPath, 'utf8')
    const used = [...spec.matchAll(/getByTestId\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
    expect(used.length).toBeGreaterThan(5)
    const declared = declaredTestIds()
    const missing = [...new Set(used)].filter((id) => !declared.some((value) => value.includes(id)))
    expect(missing, `e2e 取不到的 testid（断言会恒绿或超时）：\n  ${missing.join('\n  ')}`).toEqual([])
  })
})
