import { useEffect, useMemo, useState } from 'react'
import type { ITheme } from '@xterm/xterm'
import type { ThemeDefinition } from '@shared'
import { useShellStore } from '../app/store'
import { resolveThemeDefinition } from './builtin'
import { auditContrast, type ContrastResult } from './contrast'
import { useThemeStore, type ThemeState } from './store'
import type { ResolvedTokens } from './tokens'
import { getXtermTheme, subscribeXtermTheme } from './xterm'

/**
 * 主题相关的 React 绑定。
 *
 * `useThemeBootstrap()` 必须在 `booted` 之后调用一次：它会读 `settings.themeId`
 * 与用户主题列表，然后把 52 个 token 内联到 `<html>`、通知所有已注册的 xterm 重绘。
 *
 * 注意：zustand 的选择器必须返回**稳定引用**（直接 `state.activeTokens()` 每次都是新对象，
 * 会让 useSyncExternalStore 认为状态一直在变、触发无限重渲染），所以派生数据一律走 useMemo。
 */

export function useThemeBootstrap(): void {
  const booted = useShellStore((state) => state.booted)
  useEffect(() => {
    if (!booted) return
    void useThemeStore.getState().init()
  }, [booted])
}

export function useActiveTheme(): ThemeDefinition {
  return useThemeStore((state) => state.activeTheme())
}

export function useActiveTokens(): ResolvedTokens {
  const theme = useActiveTheme()
  return useMemo(() => resolveThemeDefinition(theme), [theme])
}

export function useActiveContrast(): ContrastResult[] {
  const tokens = useActiveTokens()
  return useMemo(() => auditContrast(tokens), [tokens])
}

export function useThemeStorage(): ThemeState['storage'] {
  return useThemeStore((state) => state.storage)
}

/** 当前 xterm 主题；主题切换时会重新渲染（组件把返回值传给 terminal.options.theme） */
export function useXtermTheme(): ITheme {
  const [theme, setTheme] = useState<ITheme>(() => getXtermTheme())
  useEffect(() => {
    setTheme(getXtermTheme())
    return subscribeXtermTheme((next) => setTheme(next))
  }, [])
  return theme
}
