import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  CircleAlert,
  Download,
  FileX,
  HardDrive,
  KeyRound,
  Lock,
  ShieldCheck,
  Timer
} from 'lucide-react'
import type { VaultLibraryMeta, VaultStatus, VaultUnlockFailure } from '@shared'
import { useShellStore } from '../../app/store'
import * as api from '../vault/api'
import { downloadTextFile } from '../vault/download'
import { useVaultErrorText, useVaultStore } from '../vault/store'
import '../vault/vault.css'

/**
 * 解锁卡的全部态（r3 AC-10：**新建库不许复用 `create`**）。
 *
 * `create` 只属于「本库还没有主口令」（`status.state === 'uninitialized'`）；
 * 新建一只库要另起三态，否则 uninitialized 下屏上会同时出现两个创建入口。
 */
type Mode =
  | 'unlock'
  | 'create'
  | 'recover'
  | 'recovery-saved'
  | 'new-library-confirm'
  | 'new-library-create'
  | 'new-library-created'

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** 台账时间 → `YYYY-MM-DD HH:mm`；无记录返回 null（**绝不填 0、绝不填当前时间**，AC-4） */
function stamp(value: string | null): string | null {
  if (value === null) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours()
  )}:${pad2(date.getMinutes())}`
}

/** 库列表的日期列只有 78px（DESIGN §2.1），用短格式 */
function shortStamp(value: string | null): string | null {
  if (value === null) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(
    date.getMinutes()
  )}`
}

/** 四类归因 → 语义色（DESIGN §2.4：红色**只**给 corrupt，slot 错配保持中性） */
function attributionTone(cls: VaultUnlockFailure['class']): 'warn' | 'notice' | 'error' {
  if (cls === 'corrupt') return 'error'
  if (cls === 'slot-record-mismatch') return 'notice'
  return 'warn'
}

/** 四类各有专属图标：不许只靠颜色区分（色盲 + 截图都判不出） */
function AttributionIcon({ cls }: { cls: VaultUnlockFailure['class'] }): JSX.Element {
  if (cls === 'bad-passphrase') return <CircleAlert size={14} aria-hidden="true" />
  if (cls === 'throttled') return <Timer size={14} aria-hidden="true" />
  if (cls === 'corrupt') return <FileX size={14} aria-hidden="true" />
  // slot-record-mismatch：刻意用中性的磁盘图标 —— 盾牌/警告三角会暗示「被攻击」
  return <HardDrive size={14} aria-hidden="true" />
}

function libraryLabel(library: VaultLibraryMeta, fallback: string): string {
  return library.name ?? fallback
}

/**
 * 库切换（AC-13）。按库数降级：1 只库只给只读行（不给只有一个选项的空交互，
 * 同时让「升级后库确实还在」可见）；≥2 只库给原生 select + 可折叠列表。
 */
function LibrarySwitcher({
  libraries,
  busy,
  onSwitch
}: {
  libraries: VaultLibraryMeta[]
  busy: boolean
  onSwitch: (id: string) => void
}): JSX.Element | null {
  const { t } = useTranslation('vaultsync')
  if (libraries.length === 0) return null
  const fallback = t('unlock.library.default')

  if (libraries.length === 1) {
    const only = libraries[0]
    return (
      <div className="ts-unlock__library ts-unlock__library--static">
        <span className="ts-unlock__library-label">{t('unlock.library.current')}</span>
        <span className="ts-unlock__library-name">{libraryLabel(only, fallback)}</span>
        <span className="ts-unlock__library-badge">{t('unlock.library.badge')}</span>
      </div>
    )
  }

  const current = libraries.find((library) => library.isCurrent) ?? libraries[0]
  const pick = (library: VaultLibraryMeta): void => {
    if (!library.isCurrent) onSwitch(library.id)
  }
  return (
    <div className="ts-unlock__library">
      <label className="ts-field" data-testid="library-switcher">
        <span className="ts-field__label">{t('unlock.library.switch')}</span>
        <select
          value={current.id}
          disabled={busy}
          aria-label={t('unlock.library.switch')}
          onChange={(event) => onSwitch(event.target.value)}
        >
          {libraries.map((library) => (
            <option key={library.id} value={library.id}>
              {libraryLabel(library, fallback)}
            </option>
          ))}
        </select>
      </label>
      {/* `library-list` 必须是 <details> 本体：e2e 直接读 `.open` 判断展开态 */}
      <details className="ts-unlock__library-details" data-testid="library-list">
        <summary className="ts-unlock__library-summary">
          <ChevronDown size={14} aria-hidden="true" className="ts-unlock__chevron" />
          <span>{t('unlock.library.list', { count: libraries.length })}</span>
        </summary>
        <div className="ts-unlock__library-list" role="listbox" aria-label={t('unlock.library.list', { count: libraries.length })}>
          {libraries.map((library) => (
            <button
              key={library.id}
              type="button"
              role="option"
              aria-selected={library.isCurrent}
              data-current={library.isCurrent ? 'true' : 'false'}
              className="ts-unlock__library-row"
              data-testid="library-row"
              title={`${t('unlock.library.createdAt', {
                time: stamp(library.createdAt) ?? t('unlock.diag.unknown')
              })} · ${t('unlock.library.lastUnlocked', {
                time: stamp(library.lastUnlockedAt) ?? t('unlock.diag.unknown')
              })}`}
              onClick={() => pick(library)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  const next = event.currentTarget.nextElementSibling
                  if (next instanceof HTMLElement) next.focus()
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  const previous = event.currentTarget.previousElementSibling
                  if (previous instanceof HTMLElement) previous.focus()
                }
              }}
            >
              <span className="ts-unlock__library-name">{libraryLabel(library, fallback)}</span>
              {library.isCurrent ? (
                <span className="ts-unlock__library-badge">{t('unlock.library.badge')}</span>
              ) : null}
              <span className="ts-unlock__library-meta">
                {shortStamp(library.lastUnlockedAt) ?? t('unlock.diag.unknown')}
              </span>
            </button>
          ))}
        </div>
      </details>
    </div>
  )
}

/**
 * 四类归因块（AC-1）。`data-class` 是 e2e 的唯一锚点 —— 不靠四段文本匹配，
 * 否则整页文本会被邻居行满足（假绿）。`bad-passphrase` 的「口令错误」字样
 * **只允许出现在这一支**（AC-1 反向守卫按文案判红）。
 */
function UnlockAttribution({
  failure,
  currentLibrary,
  lastUnlockedAt,
  retryLeft,
  onShowDiagnostics,
  onCreateLibrary
}: {
  failure: VaultUnlockFailure
  currentLibrary: string
  lastUnlockedAt: string | null
  retryLeft: number
  onShowDiagnostics: () => void
  onCreateLibrary: () => void
}): JSX.Element {
  const { t } = useTranslation('vaultsync')
  const tone = attributionTone(failure.class)
  const title =
    failure.class === 'bad-passphrase'
      ? t('unlock.attr.badTitle')
      : failure.class === 'throttled'
        ? t('unlock.attr.throttleTitle')
        : failure.class === 'corrupt'
          ? t('unlock.attr.corruptTitle')
          : t('unlock.attr.slotTitle')
  const body =
    failure.class === 'bad-passphrase'
      ? t('unlock.attr.badBody')
      : failure.class === 'throttled'
        ? t('unlock.attr.throttleBody')
        : failure.class === 'corrupt'
          ? t('unlock.attr.corruptBody')
          : t('unlock.attr.slotBody')

  return (
    <section
      className={`ts-unlock__attribution ts-unlock__attribution--${tone}`}
      data-testid="unlock-attribution"
      data-class={failure.class}
      role="alert"
    >
      <p className="ts-unlock__attribution-title">
        <AttributionIcon cls={failure.class} />
        <span>{title}</span>
      </p>
      <p className="ts-unlock__attribution-body">{body}</p>

      {failure.class === 'bad-passphrase' ? (
        <>
          <p className="ts-unlock__attribution-body">{t('unlock.attr.checksTitle')}</p>
          <ul className="ts-unlock__checks">
            <li>{t('unlock.attr.checks1')}</li>
            <li>{t('unlock.attr.checks2')}</li>
            <li>{t('unlock.attr.checks3', { name: currentLibrary })}</li>
          </ul>
        </>
      ) : null}

      {failure.class === 'throttled' ? (
        <p className="ts-unlock__attribution-body">
          {/* 数值本身 aria-live=off（每秒变会打断读屏），另给 10 秒粒度的礼貌播报 */}
          <span className="ts-unlock__countdown" data-testid="unlock-throttle-countdown" aria-live="off">
            {t('unlock.attr.throttleWait', { seconds: retryLeft })}
          </span>
          <span className="ts-unlock__sr" aria-live="polite">
            {t('unlock.attr.throttleWait', { seconds: Math.max(10, Math.ceil(retryLeft / 10) * 10) })}
          </span>
        </p>
      ) : null}

      {failure.class === 'slot-record-mismatch' ? (
        <>
          <p className="ts-unlock__attribution-body">
            {t('unlock.attr.slotLastUnlocked', {
              time: stamp(lastUnlockedAt) ?? t('unlock.diag.unknown')
            })}
          </p>
          <div className="ts-unlock__row">
            <button type="button" className="ts-link" onClick={onShowDiagnostics}>
              {t('unlock.diag.toggle')}
            </button>
            <span className="ts-vault__spacer" />
            <button type="button" className="ts-link" onClick={onCreateLibrary}>
              {t('unlock.newLibrary.entry')}
            </button>
          </div>
        </>
      ) : null}

      {failure.class === 'corrupt' ? (
        <p className="ts-unlock__attribution-body">{t('unlock.attr.corruptDoc')}</p>
      ) : null}
    </section>
  )
}

function DiagRow({
  label,
  value,
  testId
}: {
  label: string
  value: string
  testId: string
}): JSX.Element {
  return (
    <div className="ts-unlock__diag-row">
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  )
}

/**
 * 证据区（AC-2/AC-3/AC-4）：固定六项，**永不渲染任何路径**。
 * `/Users/<用户名>/…` 本身就是用户名泄露，渲染出来 AC-3 的「用户名 0 命中」直接判红。
 */
function VaultDiagnostics({
  status,
  open,
  onToggle
}: {
  status: VaultStatus | null
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const { t } = useTranslation('vaultsync')
  const unknown = t('unlock.diag.unknown')
  const kdf =
    status?.kdf == null ? unknown : `scrypt · N=${status.kdf.N} r=${status.kdf.r} p=${status.kdf.p}`
  return (
    <>
      <button
        type="button"
        className="ts-unlock__diag-toggle"
        data-testid="unlock-diag-toggle"
        aria-expanded={open}
        aria-controls="unlock-diag-panel"
        onClick={onToggle}
      >
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={open ? 'ts-unlock__chevron ts-unlock__chevron--open' : 'ts-unlock__chevron'}
        />
        <span>{t('unlock.diag.toggle')}</span>
      </button>
      {open ? (
        <div className="ts-unlock__diag" id="unlock-diag-panel" data-testid="unlock-diag">
          <dl className="ts-unlock__diag-list">
            <DiagRow
              label={t('unlock.diag.createdAt')}
              value={stamp(status?.createdAt ?? null) ?? unknown}
              testId="diag-created-at"
            />
            <DiagRow
              label={t('unlock.diag.lastUnlocked')}
              value={stamp(status?.lastUnlockedAt ?? null) ?? unknown}
              testId="diag-last-unlocked"
            />
            <DiagRow
              label={t('unlock.diag.lastSynced')}
              value={stamp(status?.lastSyncedAt ?? null) ?? unknown}
              testId="diag-last-synced"
            />
            <DiagRow
              label={t('unlock.diag.revision')}
              value={status === null ? unknown : String(status.revision)}
              testId="diag-revision"
            />
            <DiagRow label={t('unlock.diag.kdf')} value={kdf} testId="diag-kdf" />
            <DiagRow
              label={t('unlock.diag.fingerprint')}
              value={status?.slotFingerprint ?? t('unlock.diag.fingerprintUnknown')}
              testId="diag-fingerprint"
            />
          </dl>
          <p className="ts-unlock__diag-note">{t('unlock.diag.note')}</p>
        </div>
      ) : null}
    </>
  )
}

/**
 * 解锁屏（替换 `app/placeholders/LockScreen.tsx`，t7 一行接线）。
 *
 * 七种态都在这里：解锁（含四类归因 + 证据区 + 库切换）、首次创建（含弱口令二次确认）、
 * 用恢复码重置口令、恢复码留存、新建库的确认/命名/已创建。
 * 弱口令的「二次确认」是协议级的：主进程第一次抛 `weak-passphrase`，**同口令再提交一次**才接受
 * （`vault:create` 的请求体只有一个 passphrase，冻结契约里没有 confirm 字段）。
 *
 * 两条纪律：① 归因只读 `status.unlockFailure`，**不许拿 error reason 反推 class**
 * （DESIGN §7 第 2 条，否则四分类会出现第二个实现）；② 本文件不出现任何「重置/清空/删除库」
 * 的入口（AC-17），恢复码页也**不渲染 footer、不响应 Esc**（AC-16）。
 */
export function UnlockScreen(): JSX.Element {
  const { t } = useTranslation('vaultsync')
  const status = useVaultStore((state) => state.status)
  const libraries = useVaultStore((state) => state.libraries)
  const unlockFailure = useVaultStore((state) => state.unlockFailure)
  const run = useVaultStore((state) => state.run)
  const applyStatus = useVaultStore((state) => state.applyStatus)
  const reloadStatus = useVaultStore((state) => state.reloadStatus)
  const switchLibrary = useVaultStore((state) => state.switchLibrary)
  const createLibrary = useVaultStore((state) => state.createLibrary)
  const setRecoveryPending = useVaultStore((state) => state.setRecoveryPending)
  const busy = useVaultStore((state) => state.busy)
  const error = useVaultErrorText()
  const setPreviewLocked = useShellStore((state) => state.setPreviewLocked)

  const [mode, setMode] = useState<Mode>('unlock')
  const [passphrase, setPassphrase] = useState('')
  const [repeat, setRepeat] = useState('')
  const [remember, setRemember] = useState(true)
  const [recoveryCode, setRecoveryCode] = useState('')
  const [issuedRecoveryCode, setIssuedRecoveryCode] = useState<string | null>(null)
  const [weakConfirmed, setWeakConfirmed] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [newLibraryName, setNewLibraryName] = useState('')
  const [newLibraryError, setNewLibraryError] = useState<string | null>(null)
  const [switchedTo, setSwitchedTo] = useState<string | null>(null)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  /** 本轮是否已经失败过至少一次：变体进度只在「失败之后仍在飞行」时出现（AC-9） */
  const [attempted, setAttempted] = useState(false)
  const [retryLeft, setRetryLeft] = useState(0)
  const passphraseRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (status?.state === 'uninitialized') setMode('create')
  }, [status?.state])

  // 限流倒计时：数值来自主进程的 retryAfterSeconds，到 0 时把焦点送回输入框
  const throttled = unlockFailure?.class === 'throttled'
  useEffect(() => {
    if (!throttled) {
      setRetryLeft(0)
      return
    }
    const initial = Math.max(0, unlockFailure?.retryAfterSeconds ?? 0)
    setRetryLeft(initial)
    if (initial <= 0) return
    const timer = window.setInterval(() => {
      setRetryLeft((left) => {
        if (left <= 1) {
          window.clearInterval(timer)
          return 0
        }
        return left - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [throttled, unlockFailure?.retryAfterSeconds])

  useEffect(() => {
    if (throttled && retryLeft === 0) passphraseRef.current?.focus()
  }, [throttled, retryLeft])

  // AC-16：恢复码页不响应 Esc —— 这里显式吞掉，避免将来某个全局快捷键把它变成逃逸出口
  useEffect(() => {
    if (mode !== 'recovery-saved') return
    const swallow = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('keydown', swallow, true)
    return () => document.removeEventListener('keydown', swallow, true)
  }, [mode])

  function resetInputs(): void {
    setPassphrase('')
    setRepeat('')
    setRecoveryCode('')
    setWeakConfirmed(false)
    setLocalError(null)
    setNewLibraryError(null)
    setSwitchedTo(null)
    setAttempted(false)
  }

  async function unlock(): Promise<void> {
    if (passphrase === '') return
    const next = await run(() => api.unlockVault(passphrase, remember))
    if (next !== null) {
      resetInputs()
      setDiagnosticsOpen(false)
      applyStatus(next)
      return
    }
    // 失败：清空并重新聚焦（口令不留在屏上，也不留在 DOM 里）
    setAttempted(true)
    setPassphrase('')
    setRepeat('')
    // 归因来自主进程推来的 status（不是 error.reason）
    await reloadStatus()
    passphraseRef.current?.focus()
  }

  async function create(): Promise<void> {
    if (passphrase !== repeat) {
      setLocalError(t('unlock.mismatch'))
      return
    }
    // **必须在 IPC 之前**挂上「恢复码未确认」：主进程建库成功会先广播
    // `vault:state-changed`（state 已是 unlocked），那一帧如果这个标志还是 false，
    // 外壳就会立刻接管、解锁屏被卸载，恢复码页一闪而过（实测复现：AC-16 的逃逸不是
    // 靠按钮打开的，而是靠这帧竞态）。放在 await 之后写等于没写。
    setRecoveryPending(true)
    const result = await run(() => api.createVault(passphrase))
    if (result === null) {
      // 建库没成功（弱口令/其它）→ 立刻撤掉，别把用户锁在一个永远不会到的等待里
      setRecoveryPending(false)
      if (useVaultStore.getState().error === 'weak-passphrase') setWeakConfirmed(true)
      return
    }
    setIssuedRecoveryCode(result.recoveryCode)
    applyStatus(result.status)
    setMode('recovery-saved')
  }

  async function recover(): Promise<void> {
    if (passphrase !== repeat) {
      setLocalError(t('unlock.mismatch'))
      return
    }
    const next = await run(() => api.recoverVault(recoveryCode, passphrase))
    if (next !== null) {
      resetInputs()
      applyStatus(next)
      setMode('unlock')
    }
  }

  async function submitNewLibrary(): Promise<void> {
    const name = newLibraryName.trim()
    if (name === '') return
    setNewLibraryError(null)
    const result = await createLibrary({ name, rememberWithKeychain: false })
    if (result === null) {
      const reason = useVaultStore.getState().error
      // AC-14：重名/目录占用 → 行内一行错误，不弹窗、不打断输入
      if (reason === 'name-taken' || reason === 'dir-taken' || reason === 'already-exists') {
        setNewLibraryError(t('unlock.newLibrary.exists'))
      }
      return
    }
    resetInputs()
    // 新库此刻是 uninitialized，`status.state` 的 effect 会把它切到 `create`
    setMode('new-library-created')
  }

  async function onSwitch(id: string): Promise<void> {
    const target = libraries.find((library) => library.id === id)
    const name = target === undefined ? t('unlock.library.default') : libraryLabel(target, t('unlock.library.default'))
    resetInputs()
    setDiagnosticsOpen(false)
    setSwitchedTo(name)
    await switchLibrary(id)
    passphraseRef.current?.focus()
  }

  const creating = mode === 'create' || mode === 'new-library-created'
  const recovering = mode === 'recover'
  const savingRecovery = mode === 'recovery-saved'
  const confirmingLibrary = mode === 'new-library-confirm'
  const namingLibrary = mode === 'new-library-create'
  const unlockMode = mode === 'unlock'
  const currentLibrary =
    libraries.find((library) => library.isCurrent) ?? null
  const currentLibraryName =
    currentLibrary === null
      ? t('unlock.library.default')
      : libraryLabel(currentLibrary, t('unlock.library.default'))
  const throttledNow = unlockFailure?.class === 'throttled' && retryLeft > 0

  const title = savingRecovery
    ? t('unlock.recoveryTitle')
    : confirmingLibrary || namingLibrary
      ? t('unlock.newLibrary.title')
      : creating
        ? t('unlock.createTitle')
        : recovering
          ? t('unlock.recoverTitle')
          : t('unlock.title')
  const subtitle = confirmingLibrary || namingLibrary
    ? t('unlock.newLibrary.subtitle')
    : creating
      ? t('unlock.createSubtitle')
      : t('unlock.subtitle')

  const primaryLabel = busy
    ? t('unlock.unlocking')
    : unlockMode
      ? unlockFailure?.class === 'bad-passphrase'
        ? t('unlock.attr.retry')
        : t('unlock.submit')
      : creating
        ? t('unlock.createSubmit')
        : recovering
          ? t('unlock.recoverSubmit')
          : t('unlock.submit')

  return (
    <div
      className="ts-unlock"
      data-testid="unlock-screen"
      // 七态机的当前态与库状态挂成属性：e2e 判「现在在哪个态」不必去猜按钮文案
      data-mode={mode}
      data-vault-state={status?.state ?? 'none'}
    >
      <div className="ts-unlock__card">
        <header className="ts-unlock__head">
          <span className="ts-unlock__icon">
            {savingRecovery || creating ? (
              <KeyRound size={18} aria-hidden="true" />
            ) : confirmingLibrary || namingLibrary ? (
              <HardDrive size={18} aria-hidden="true" />
            ) : (
              <Lock size={18} aria-hidden="true" />
            )}
          </span>
          <div>
            <h2 className="ts-unlock__title">{title}</h2>
            <p className="ts-unlock__subtitle">{subtitle}</p>
          </div>
        </header>

        {unlockMode ? (
          <LibrarySwitcher libraries={libraries} busy={busy} onSwitch={(id) => void onSwitch(id)} />
        ) : null}
        {unlockMode && switchedTo !== null ? (
          <p className="ts-unlock__subtitle" aria-live="polite">
            {t('unlock.library.switchedTo', { name: switchedTo })}
          </p>
        ) : null}

        {savingRecovery ? (
          <div className="ts-unlock__recovery" data-testid="unlock-recovery-code" aria-labelledby="unlock-recovery-title">
            <p className="ts-unlock__warn" id="unlock-recovery-title">
              <ShieldCheck size={14} aria-hidden="true" /> {t('unlock.recoveryTitle')}
            </p>
            <p className="ts-unlock__subtitle">{t('unlock.recoveryBody')}</p>
            <code className="ts-unlock__code">{issuedRecoveryCode}</code>
            <div className="ts-unlock__row">
              <button
                type="button"
                className="ts-btn ts-btn--ghost"
                onClick={() => downloadTextFile('termans-recovery-code.txt', issuedRecoveryCode ?? '')}
              >
                <Download size={14} aria-hidden="true" /> {t('unlock.recoveryDownload')}
              </button>
              <span className="ts-vault__spacer" />
              <button
                type="button"
                className="ts-btn ts-btn--primary"
                data-testid="unlock-recovery-done"
                onClick={() => {
                  setIssuedRecoveryCode(null)
                  setRecoveryPending(false)
                  resetInputs()
                  setMode('unlock')
                }}
              >
                {t('unlock.recoveryDone')}
              </button>
            </div>
          </div>
        ) : confirmingLibrary ? (
          <div className="ts-unlock__confirm" data-testid="create-library-confirm">
            <p className="ts-unlock__attribution-body">{t('unlock.newLibrary.lead')}</p>
            <ol className="ts-unlock__confirm-list" data-testid="create-library-confirm-points">
              <li>{t('unlock.newLibrary.point1')}</li>
              <li>{t('unlock.newLibrary.point2')}</li>
              <li>{t('unlock.newLibrary.point3')}</li>
            </ol>
            <div className="ts-unlock__row">
              <button
                type="button"
                className="ts-btn ts-btn--ghost"
                data-testid="new-library-cancel"
                onClick={() => {
                  resetInputs()
                  setMode('unlock')
                }}
              >
                {t('unlock.newLibrary.cancel')}
              </button>
              <span className="ts-vault__spacer" />
              <button
                type="button"
                className="ts-btn ts-btn--primary"
                data-testid="new-library-continue"
                onClick={() => {
                  // 默认名不许取自旧库路径或可见库名（AC-15 的 anti-pattern）
                  setNewLibraryName(t('unlock.newLibrary.defaultName', { index: libraries.length + 1 }))
                  setNewLibraryError(null)
                  setMode('new-library-create')
                }}
              >
                {t('unlock.newLibrary.continue')}
              </button>
            </div>
          </div>
        ) : namingLibrary ? (
          <form
            className="ts-unlock__form"
            onSubmit={(event) => {
              event.preventDefault()
              void submitNewLibrary()
            }}
          >
            <label className="ts-field">
              <span className="ts-field__label">{t('unlock.newLibrary.nameLabel')}</span>
              <input
                required
                autoFocus
                value={newLibraryName}
                placeholder={t('unlock.newLibrary.namePlaceholder')}
                onChange={(event) => setNewLibraryName(event.target.value)}
                data-testid="new-library-name"
              />
            </label>
            {newLibraryError !== null ? (
              <p className="ts-unlock__inline-error" role="alert">
                {newLibraryError}
              </p>
            ) : null}
            <div className="ts-unlock__row">
              <button
                type="button"
                className="ts-link"
                data-testid="new-library-cancel"
                onClick={() => {
                  resetInputs()
                  setMode('unlock')
                }}
              >
                {t('unlock.newLibrary.cancel')}
              </button>
              <span className="ts-vault__spacer" />
              <button
                type="submit"
                className="ts-btn ts-btn--primary"
                disabled={busy || newLibraryName.trim() === ''}
                data-testid="new-library-submit"
              >
                {t('unlock.newLibrary.submit')}
              </button>
            </div>
          </form>
        ) : (
          <form
            className="ts-unlock__form"
            onSubmit={(event) => {
              event.preventDefault()
              if (creating) void create()
              else if (recovering) void recover()
              else void unlock()
            }}
          >
            {recovering ? (
              <label className="ts-field">
                <span className="ts-field__label">{t('unlock.recoveryCode')}</span>
                <input
                  required
                  value={recoveryCode}
                  placeholder={t('unlock.recoveryPlaceholder')}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  data-testid="recovery-code-input"
                />
              </label>
            ) : null}

            <label className="ts-field">
              <span className="ts-field__label">
                {creating || recovering ? t('unlock.newPassphrase') : t('unlock.passphrase')}
              </span>
              <input
                required
                ref={passphraseRef}
                type="password"
                autoFocus
                autoComplete="current-password"
                spellCheck={false}
                value={passphrase}
                placeholder={t('unlock.passphrasePlaceholder')}
                onChange={(event) => setPassphrase(event.target.value)}
                data-testid="passphrase-input"
              />
            </label>

            {creating || recovering ? (
              <label className="ts-field">
                <span className="ts-field__label">{t('unlock.repeatPassphrase')}</span>
                <input
                  required
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={repeat}
                  onChange={(event) => setRepeat(event.target.value)}
                  data-testid="passphrase-repeat"
                />
              </label>
            ) : null}

            {unlockMode ? (
              <label className="ts-vault__check">
                <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
                <span>{t('unlock.remember')}</span>
              </label>
            ) : null}

            {weakConfirmed ? (
              <p className="ts-unlock__warn" data-testid="weak-passphrase-warning">
                {t('unlock.weakTitle')} — {t('unlock.weakBody')}
              </p>
            ) : null}

            {unlockMode && unlockFailure !== null ? (
              <UnlockAttribution
                failure={unlockFailure}
                currentLibrary={currentLibraryName}
                lastUnlockedAt={status?.lastUnlockedAt ?? null}
                retryLeft={retryLeft}
                onShowDiagnostics={() => setDiagnosticsOpen(true)}
                onCreateLibrary={() => {
                  resetInputs()
                  setMode('new-library-confirm')
                }}
              />
            ) : null}

            {attempted && busy ? (
              <p className="ts-unlock__progress" data-testid="unlock-progress" aria-live="polite">
                {t('unlock.variant.progress')}
              </p>
            ) : null}

            {localError !== null ? <p className="ts-unlock__error">{localError}</p> : null}
            {/* 有归因块时不再叠一层 reason 文案：两套词表混在一屏会让用户猜哪个才是结论 */}
            {error !== null && unlockFailure === null ? <p className="ts-unlock__error">{error}</p> : null}

            <div className="ts-unlock__row">
              {/* create 态没有「回去」的地方（本库还没有口令），渲染一个点了没反应的链接
                  比不渲染更糟 —— 所以这里只在 unlock / recover 两种态给次级链接。 */}
              {creating ? null : unlockMode ? (
                <button
                  type="button"
                  className="ts-link"
                  onClick={() => {
                    resetInputs()
                    setMode('recover')
                  }}
                >
                  {t('unlock.forgot')}
                </button>
              ) : (
                <button
                  type="button"
                  className="ts-link"
                  onClick={() => {
                    resetInputs()
                    setMode(status?.state === 'uninitialized' ? 'create' : 'unlock')
                  }}
                >
                  {t('unlock.backToUnlock')}
                </button>
              )}
              <span className="ts-vault__spacer" />
              <button
                type="submit"
                className="ts-btn ts-btn--primary"
                disabled={busy || (unlockMode && throttledNow)}
                aria-busy={busy}
                data-testid={creating ? 'create-vault' : recovering ? 'recover-vault' : 'unlock-vault'}
              >
                {primaryLabel}
              </button>
            </div>

            {unlockMode ? (
              <VaultDiagnostics
                status={status}
                open={diagnosticsOpen}
                onToggle={() => setDiagnosticsOpen((open) => !open)}
              />
            ) : null}
          </form>
        )}

        {/* AC-16：恢复码页不渲染 footer —— 「继续以预览模式使用」就是那个逃逸出口 */}
        {savingRecovery ? null : (
          <footer className="ts-unlock__foot">
            {unlockMode && status?.state === 'locked' ? (
              <button
                type="button"
                className="ts-link"
                data-testid="create-library-entry"
                onClick={() => {
                  resetInputs()
                  setMode('new-library-confirm')
                }}
              >
                {t('unlock.newLibrary.entry')}
              </button>
            ) : null}
            <button
              type="button"
              className="ts-link"
              onClick={() => setPreviewLocked(true)}
              data-testid="preview-mode"
            >
              {t('unlock.previewMode')}
            </button>
          </footer>
        )}
      </div>
    </div>
  )
}
