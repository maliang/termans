import { i18next } from '@renderer/i18n'

/**
 * i18next v26 兼容垫片（t7 接线期发现，单点、可整块删除）。
 *
 * 现象：渲染进程整页白屏，控制台只有一行
 * `Uncaught TypeError: instance.addResourceBundle is not a function`
 * （打包产物里是 `instance.addResourceBundle is not a function`），来源是
 * `src/renderer/features/vault/i18n.ts` 顶层的
 * `i18next.addResourceBundle('en', 'vaultsync', en, true, true)`。
 *
 * 根因：**i18next 26 把 `addResourceBundle` 从 I18n 实例移到了 `services.resourceStore`**
 * （`node_modules/i18next/dist/esm/i18next.js` 里该方法如今挂在 `ResourceStore` 类上），
 * 但 `node_modules/i18next/index.d.ts:524` 的类型声明还没跟上——所以 **typecheck 全绿、
 * 运行时才炸**，而且没人 import 这个模块时永远看不到（vault 一接线就白屏）。
 * 另外 `services` 要等 `init()` 之后才有内容，而 feature 的 `i18n.ts` 在模块**求值**时就调用，
 * 早于 `main.tsx` 里的 `await initI18n()`，所以还要把调用排队到 `initialized` 事件之后。
 *
 * 为什么不直接改 `features/vault/i18n.ts`：那不在 t7 的可改范围（已上报 captain / vault-sync，
 * 建议他们把这段文案搬进 `src/locales/{en,zh-CN}/vaultsync.json` 并删掉这两行）。
 * 垫片放在接线层，属于「让已交付模块跑起来」的最小改动，删掉它不影响任何契约。
 */

type AddResourceBundle = (
  language: string,
  namespace: string,
  resources: Record<string, unknown>,
  deep?: boolean,
  overwrite?: boolean
) => void

interface ResourceStoreLike {
  addResourceBundle: AddResourceBundle
}

interface I18nLike {
  addResourceBundle?: AddResourceBundle
  services?: { resourceStore?: ResourceStoreLike }
  on?: (event: string, listener: () => void) => void
}

const instance = i18next as unknown as I18nLike
const pending: Array<Parameters<AddResourceBundle>> = []

function store(): ResourceStoreLike | null {
  return instance.services?.resourceStore ?? null
}

function flush(): void {
  const target = store()
  if (!target) return
  while (pending.length > 0) {
    const args = pending.shift()
    if (args) target.addResourceBundle(...args)
  }
}

function install(): void {
  if (typeof instance.addResourceBundle === 'function') return
  instance.addResourceBundle = (language, namespace, resources, deep, overwrite) => {
    const target = store()
    if (!target) {
      pending.push([language, namespace, resources, deep, overwrite])
      return
    }
    target.addResourceBundle(language, namespace, resources, deep, overwrite)
  }
  // init 之前 services 是空的：等 i18next 完成初始化再把排队的 bundle 灌进去
  instance.on?.('initialized', flush)
}

install()
