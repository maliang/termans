import type { HostOption, QuickConnectInput, TabBackend } from '../../tabs/backend'

/**
 * 假主机来源（dev / e2e 专用）：让「新建页签 = 选主机 / 快速连接」这条链路在没有主进程、
 * 没有 SSH 服务（甚至没有 Electron）的情况下也能点通。
 */

export const MOCK_HOSTS: HostOption[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    label: 'mock-host',
    hostname: '127.0.0.1',
    port: 2222,
    username: 'mock',
    color: '#4f9cf9',
    groupName: 'Mock'
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    label: 'mock-db',
    hostname: '10.0.0.12',
    port: 22,
    username: 'deploy',
    color: '#f2b544',
    groupName: 'Mock'
  }
]

export const MOCK_DEFAULT_HOST_ID = MOCK_HOSTS[0]!.id

export function createMockTabBackend(): TabBackend {
  const hosts: HostOption[] = [...MOCK_HOSTS]
  return {
    kind: 'mock',
    listHosts: () => Promise.resolve([...hosts]),
    createQuickHost: (input: QuickConnectInput) => {
      const host: HostOption = {
        id: crypto.randomUUID(),
        label: input.label ?? `${input.username}@${input.hostname}`,
        hostname: input.hostname,
        port: input.port,
        username: input.username,
        color: null,
        groupName: 'Quick'
      }
      hosts.push(host)
      return Promise.resolve(host)
    }
  }
}
