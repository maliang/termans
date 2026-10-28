/**
 * `@shared` 的公共出口。
 *
 * 其他成员 `import { ... } from '@shared'` 即可，不必记具体文件；
 * 主进程/渲染进程/preload 三端共用同一份类型，避免「两边各写一份、悄悄不一致」。
 */

export * from './errors'
export * from './i18n'
export * from './ipc'
export * from './theme'
export * from './bridge'

export * from './models/app'
export * from './models/ai'
export * from './models/host'
export * from './models/known-host'
export * from './models/settings'
export * from './models/ssh-config'
export * from './models/terminal'
export * from './models/vault'
