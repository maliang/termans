import type { GroupInput, HostInput } from '@shared'
import { emptyPayload, type VaultPayload } from './model'

/**
 * 测试夹具（只被 *.test.ts 引用，不进打包产物）。
 *
 * 注意：这里**故意**包含看起来像生产数据的主机名/IP/密码，
 * 好让「仓库里 grep 不到明文」的断言真的有意义。
 */

export const FIXTURE_PASSWORD = 'Sup3r-Secret-P@ssw0rd'
export const FIXTURE_PASSPHRASE = 'key-passphrase-for-prod'
export const FIXTURE_HOSTNAMES = ['10.20.30.40', 'prod-db-01.internal.example.com', '2001:db8::42'] as const
export const PRIVATE_KEY_MARKER = '-----BEGIN OPENSSH PRIVATE KEY-----'

export function hostInput(overrides: Partial<HostInput> = {}): HostInput {
  return {
    label: 'prod-web-01',
    groupId: null,
    hostname: FIXTURE_HOSTNAMES[0],
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    privateKeyPath: null,
    credentialRef: null,
    jumpHostId: null,
    forwardAgent: false,
    keepaliveSeconds: 30,
    terminalProfileId: null,
    startupCommand: null,
    env: {},
    tags: [],
    color: null,
    portForwards: [],
    sshConfigOrigin: null,
    ...overrides
  }
}

export function groupInput(overrides: Partial<GroupInput> = {}): GroupInput {
  return { name: 'Production', parentId: null, color: null, ...overrides }
}

export function payload(now = '2026-01-01T00:00:00.000Z'): VaultPayload {
  return emptyPayload(now)
}
