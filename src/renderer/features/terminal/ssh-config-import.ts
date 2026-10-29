import { describeError } from '@renderer/platform/ipc'
import { useVaultStore, vaultApi } from '@renderer/features/vault'

/**
 * 空会话态里的「导入 ~/.ssh/config」。
 *
 * 为什么不是新造一条 IPC：导入链路早就有了（主机库工具条上的那个按钮），
 * 这里只是把**同一组已有调用**搬给空态用——`ssh-config:default-paths` →
 * `ssh-config:parse`（先确认文件真的存在）→ `ssh-config:import` → 刷新主机库。
 * 校验顺序和 `features/vault/HostSidebar.tsx` 的 `importSshConfig()` 保持一致，
 * 免得两个入口对「文件不存在」给出不同行为。
 */

export type SshConfigImportOutcome =
  | { kind: 'imported'; path: string; imported: number; skipped: number }
  | { kind: 'missing'; path: string }
  | { kind: 'failed'; message: string }

export async function importDefaultSshConfig(): Promise<SshConfigImportOutcome> {
  let path = ''
  try {
    const paths = await vaultApi.defaultSshConfigPaths()
    const first = paths[0]
    if (!first) return { kind: 'failed', message: 'no default ssh config path' }
    path = first

    const parsed = await vaultApi.parseSshConfig(path)
    if (!parsed.exists) return { kind: 'missing', path }

    const result = await vaultApi.importSshConfig({ path, aliases: null, overwriteExisting: false })
    await useVaultStore.getState().refresh()
    return {
      kind: 'imported',
      path,
      imported: result.importedAliases.length,
      skipped: result.skipped.length
    }
  } catch (cause) {
    return { kind: 'failed', message: describeError(cause) }
  }
}
