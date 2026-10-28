import { useEffect, useRef, useState } from 'react'
import { useTerminalRuntime } from './runtime-context'

/**
 * 终端内搜索条（addon-search）。
 *
 * 只做「找 + 高亮 + 上下跳」，不做替换：终端里的匹配是历史输出，改写它没有意义。
 * 结果计数来自 addon 的 onDidChangeResults，所以「3/17」是真实命中数而不是我们自己数的。
 */

export interface TerminalSearchBarProps {
  tabId: string | null
  onClose: () => void
}

export function TerminalSearchBar({ tabId, onClose }: TerminalSearchBarProps) {
  const runtime = useTerminalRuntime()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ index: number; count: number }>({ index: -1, count: 0 })

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const handle = tabId ? runtime.handle(tabId) : null
    if (!handle) return
    const subscription = handle.search.onDidChangeResults((event) =>
      setResults({ index: event.resultIndex, count: event.resultCount })
    )
    return () => {
      subscription.dispose()
      handle.search.clearDecorations()
    }
  }, [runtime, tabId])

  /**
   * `term` 必须由调用方显式传入（`event.target.value`），不能用 state 里的 `query`：
   * setState 之后同一次渲染里 `query` 还是旧值，边打字边搜会**永远慢一个字符**，
   * 用 `fill()` 之类一次性赋值时更极端——`query` 一直是空串，搜索根本发不出去（表现成永远 0/0）。
   */
  const runSearch = (direction: 'next' | 'prev', term: string): void => {
    if (!term) {
      runtime.search(tabId, '')
      setResults({ index: -1, count: 0 })
      return
    }
    runtime.search(tabId, term, direction)
  }

  return (
    <div className="ts-term-search" data-testid="term-search">
      <input
        ref={inputRef}
        className="ts-term-search__input"
        data-testid="term-search-input"
        type="text"
        value={query}
        placeholder="在终端中查找"
        aria-label="在终端中查找"
        onChange={(event) => {
          const next = event.target.value
          setQuery(next)
          runSearch('next', next)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            runSearch(event.shiftKey ? 'prev' : 'next', query)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
      />
      <span className="ts-term-search__count" data-testid="term-search-count">
        {results.count > 0 ? `${results.index + 1}/${results.count}` : query ? '0/0' : ''}
      </span>
      <button
        type="button"
        className="ts-icon-btn"
        data-testid="term-search-prev"
        title="上一个（Shift+Enter）"
        onClick={() => runSearch('prev', query)}
      >
        ↑
      </button>
      <button
        type="button"
        className="ts-icon-btn"
        data-testid="term-search-next"
        title="下一个（Enter）"
        onClick={() => runSearch('next', query)}
      >
        ↓
      </button>
      <button
        type="button"
        className="ts-icon-btn"
        data-testid="term-search-close"
        title="关闭搜索（Esc）"
        onClick={onClose}
      >
        ✕
      </button>
    </div>
  )
}
