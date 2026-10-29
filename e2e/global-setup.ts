import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * e2e 的「产物新鲜度」闸门——**先红得明白，别让 30 秒超时误导人**。
 *
 * 背景：`playwright.config.ts` 驱动的是 `out/` 里的构建产物，而 `npx playwright test`
 * **不会** build（只有 `pnpm test:e2e` 内置 build）。谁直接跑 `npx playwright test`，
 * 验的就是上一次 build 时的界面——这类红是真红，但红的原因不是被测代码，会把人引去改别人的代码。
 *
 * ⚠️ 归因纪律（2026-10-29 的教训）：`dual-machine` 那 3 条红**最后查明与产物过期无关**，
 * 真因是 `e2e/fixtures/ui.ts` 的 `closeSyncPanel()` 只写了「点取消按钮」一条分支，而同步面板
 * 已被 `44e6bce` 改成设置弹窗内嵌（按契约不渲染取消按钮）。captain 曾用「产物过期」解释它，
 * 被 terminal-ui 用 `git log` + 同一产物两次复跑顶回来。**这道闸门只解决「忘了 build」，
 * 不要拿它解释任何一次具体的红。**
 *
 * 判据用「有没有比产物更新的源码」，不是 commit 时间（提交时间必然晚于文件 mtime，
 * 拿它比会稳定误报，反例写在 docs/TESTING.md §6.3）。
 */
const ARTIFACTS = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']

export default async function globalSetup(): Promise<void> {
  const root = process.cwd()
  const present = ARTIFACTS.map((relative) => join(root, relative)).filter((path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  })

  if (present.length === 0) {
    throw new Error(
      [
        '找不到 e2e 的构建产物（out/main/index.js 等）。',
        'e2e 驱动的是 out/ 里的产物，不是源码：先 `pnpm build`，或直接 `pnpm test:e2e`（它内置 build）。'
      ].join('\n')
    )
  }

  // 用三份产物里**最旧**的那份当基准：任一份落后于源码都说明该重建。
  const oldest = present.reduce((acc, path) => (statSync(path).mtimeMs < statSync(acc).mtimeMs ? path : acc))
  let newer: string[] = []
  try {
    const output = execFileSync('find', ['src', '-type', 'f', '-newer', oldest], {
      cwd: root,
      encoding: 'utf8'
    })
    newer = output.split('\n').filter((line) => line.trim().length > 0)
  } catch {
    // find 不存在（极端环境）时跳过闸门，不阻塞 e2e——闸门是保险，不是唯一防线。
    return
  }

  if (newer.length > 0) {
    const shown = newer.slice(0, 10).map((path) => `  - ${path}`)
    const more = newer.length > shown.length ? [`  … 另有 ${newer.length - shown.length} 个`] : []
    throw new Error(
      [
        '产物过期：先 `pnpm build`（或用 `pnpm test:e2e`，它内置 build），否则这轮 e2e 红的是上一版界面。',
        `判断依据：以下源码比最旧的产物（${oldest.replace(root + '/', '')}）新`,
        ...shown,
        ...more
      ].join('\n')
    )
  }
}
