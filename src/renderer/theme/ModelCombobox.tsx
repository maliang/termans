import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Search } from 'lucide-react'

/**
 * 模型输入 = 可搜索组合框（ARIA 1.2 手写，不引库）。
 *
 * 三个必须守住的点：
 * 1. **浮层 portal 到 `document.body`**：设置对话框的内容区是 `overflow: auto` 的滚动容器，
 *    就地渲染的下拉会被裁掉（这不是审美问题，是「点不到」的功能缺陷）。
 * 2. **受控且只在点选时 `onChange`**：手输的任意模型名不会被「读取模型」的结果覆盖
 *    （AC-5）。组件从不写 `value`，也不在 `options` 变化时回填第一项。
 * 3. **输入框保留既有可访问名**：调用方通过 `ariaLabel` 显式传入（label 里还有「读取模型」
 *    按钮与 `▾`，靠包裹 label 推断出的可访问名不再是纯「模型」）。
 */

export interface ModelComboboxProps {
  value: string
  options: string[]
  onChange: (value: string) => void
  ariaLabel: string
  inputTestId?: string
  optionTestIdPrefix?: string
  disabled?: boolean
  /** 递增这个值会让浮层自动展开（「读取模型」成功后把结果摊给用户看） */
  openToken?: number
}

/** 单次渲染上限：服务商峰值约 1k 条，全量渲染会卡住主线程 */
const MAX_RENDERED = 200

interface PanelRect {
  left: number
  top: number
  width: number
}

export function ModelCombobox({
  value,
  options,
  onChange,
  ariaLabel,
  inputTestId = 'ai-provider-model',
  optionTestIdPrefix = 'ai-model-option-',
  disabled = false,
  openToken = 0
}: ModelComboboxProps): JSX.Element {
  const { t } = useTranslation(['ai'])
  const baseId = useId()
  const listId = `${baseId}-list`
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [rect, setRect] = useState<PanelRect | null>(null)
  const lastOpenToken = useRef(openToken)
  /** 本次展开是否要把焦点送进搜索框（点击/▾ 是；`↓` 从输入框展开时焦点留在输入框） */
  const wantSearchFocus = useRef(false)

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const matched = keyword.length === 0 ? options : options.filter((model) => model.toLowerCase().includes(keyword))
    return matched.slice(0, MAX_RENDERED)
  }, [options, query])

  const measure = useCallback((): void => {
    const trigger = inputRef.current?.parentElement
    if (!trigger) return
    const box = trigger.getBoundingClientRect()
    setRect({ left: box.left, top: box.bottom + 4, width: Math.max(box.width, 320) })
  }, [])

  const close = useCallback((): void => {
    setOpen(false)
    setQuery('')
  }, [])

  const openPanel = useCallback(
    (focusSearch: boolean): void => {
      if (disabled) return
      measure()
      setQuery('')
      // 打开时高亮「与当前值完全相等」的行（手输过的模型下次打开能被指出来）
      const index = options.findIndex((model) => model === value)
      setActiveIndex(index >= 0 ? index : 0)
      wantSearchFocus.current = focusSearch
      setOpen(true)
    },
    [disabled, measure, options, value]
  )

  // 打开后把焦点送进搜索框。**不能**在 click 里直接 requestAnimationFrame：React 18 的提交
  // 走调度器宏任务，rAF 有可能早于提交跑，那时 panelRef 还是 null，focus() 静默落空
  // （实测焦点留在 ▾ 按钮上，于是浮层里的 Esc 冒泡到 window，把整个设置关掉）。
  useEffect(() => {
    if (!open || !wantSearchFocus.current) return
    wantSearchFocus.current = false
    panelRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
  }, [open])

  // 「读取模型」成功后由父层推进 token：结果要立刻可见，不让用户再点一次 ▾
  useEffect(() => {
    if (openToken === lastOpenToken.current) return
    lastOpenToken.current = openToken
    if (options.length > 0) openPanel(false)
  }, [openPanel, openToken, options.length])

  // 滚动 / 缩放时浮层会与触发器错位。
  // 这里**重新量位置**而不是关掉：关掉会在「用户正要点选项」的瞬间把浮层拔掉
  // （设置对话框本身是滚动容器，读模型后一滚动就整个消失，点选直接落空）。
  useEffect(() => {
    if (!open) return
    let frame = 0
    const remeasure = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    const onScroll = (event: Event): void => {
      // 浮层内部自己的滚动不用管
      if (panelRef.current?.contains(event.target as Node)) return
      remeasure()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', remeasure)
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', remeasure)
    }
  }, [measure, open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (panelRef.current?.contains(target)) return
      if (inputRef.current?.parentElement?.contains(target)) return
      close()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [close, open])

  const commit = useCallback(
    (model: string): void => {
      onChange(model)
      close()
      inputRef.current?.focus()
    },
    [close, onChange]
  )

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) {
        openPanel(false)
        return
      }
      setActiveIndex((index) => Math.min(index + 1, Math.max(filtered.length - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      if (!open) return
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      if (!open) return
      event.preventDefault()
      const picked = filtered[activeIndex]
      if (picked !== undefined) commit(picked)
      else close()
      return
    }
    if (event.key === 'Escape') {
      if (!open) return
      event.preventDefault()
      // Esc 只关浮层，不动输入值。**必须 stopPropagation**：设置对话框宿主把 Escape=关对话框
      // 挂在 window 上（SettingsDialogHost），且不检查 defaultPrevented——浮层里的 Esc 只要
      // 继续冒泡就会顺手把整个设置关掉，「Esc 只关浮层」这条契约靠 preventDefault 守不住。
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'Tab' && open) {
      // Tab 离开即收起（DESIGN §3.3）。不 preventDefault：焦点该去哪去哪。
      // 不能只靠 onBlur——Tab 到「没有下一个可聚焦元素」时 relatedTarget 是 null，分不清
      // 「跳走了」还是「点了浮层里的非聚焦区域」，会漏关。
      close()
      return
    }
    if (event.key === 'Home' && open) {
      event.preventDefault()
      setActiveIndex(0)
      return
    }
    if (event.key === 'End' && open) {
      event.preventDefault()
      setActiveIndex(Math.max(filtered.length - 1, 0))
    }
  }

  const activeOptionId = filtered.length > 0 ? `${baseId}-opt-${activeIndex}` : undefined

  return (
    <div
      className="ts-ai-model-combo"
      data-testid="ai-provider-models-combo"
      // 键盘处理挂在容器上而不是只挂在输入框上：焦点可能落在 ▾ 按钮（点开后、或刚好点到它），
      // 那时 Esc/Enter 也要归浮层管，否则会继续冒泡到 window 把设置对话框关掉。
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        // Tab 离开（DESIGN §3.3 的第三种关闭方式）：焦点跳到组合框与浮层之外的任何地方就收起。
        // relatedTarget=null 交给「点外部」的 mousedown 分支处理，避免点浮层内非聚焦区域时误关。
        const next = event.relatedTarget as Node | null
        if (next === null) return
        if (event.currentTarget.contains(next)) return
        if (panelRef.current?.contains(next)) return
        close()
      }}
    >
      <div className="ts-ai-model-combo__trigger">
        <input
          ref={inputRef}
          className="ts-settings__input ts-ai-model-combo__input"
          data-testid={inputTestId}
          aria-label={ariaLabel}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open ? activeOptionId : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onClick={() => (open ? close() : openPanel(false))}
        />
        <button
          type="button"
          className="ts-ai-model-combo__toggle"
          aria-label={t('ai:provider.models.toggle')}
          title={t('ai:provider.models.toggle')}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => (open ? close() : openPanel(true))}
        >
          <ChevronDown size={14} aria-hidden="true" data-open={open ? 'true' : 'false'} />
        </button>
      </div>

      {open && rect
        ? createPortal(
            <div
              ref={panelRef}
              className="ts-ai-model-combo__panel"
              style={{ left: rect.left, top: rect.top, width: rect.width }}
            >
              <div className="ts-ai-model-combo__search">
                <Search size={12} aria-hidden="true" />
                <input
                  type="search"
                  aria-label={t('ai:provider.models.searchPlaceholder')}
                  placeholder={t('ai:provider.models.searchPlaceholder')}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setActiveIndex(0)
                  }}
                  onKeyDown={onKeyDown}
                />
              </div>
              {filtered.length > 0 ? (
                <ul className="ts-ai-model-combo__list" id={listId} role="listbox" aria-label={ariaLabel}>
                  {filtered.map((model, index) => (
                    <li key={`${model}-${index}`} role="none">
                      <button
                        type="button"
                        id={`${baseId}-opt-${index}`}
                        role="option"
                        aria-selected={index === activeIndex}
                        className="ts-ai-model-combo__option"
                        data-testid={`${optionTestIdPrefix}${model}`}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => commit(model)}
                      >
                        <span className="ts-ai-model-combo__option-label">{model}</span>
                        {model === value ? (
                          <span className="ts-ai-model-combo__option-tag">{t('ai:provider.models.current')}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="ts-ai-model-combo__empty" role="status">
                  {t('ai:provider.models.noMatch', { value: value.trim().length > 0 ? value : '—' })}
                </p>
              )}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
