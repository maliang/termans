/**
 * 主机库（vault）模块入口。
 *
 * 目录职责：
 * - `crypto/`  信封与口令：scrypt + AES-256-GCM、恢复码、口令强度（纯函数，可单测）
 * - `vault/`   数据模型、迁移、主机库纯函数、本机凭据、ssh_config 文本、IPC 接线
 * - `git/`     isomorphic-git 管道 + 乐观锁同步协调器 + 逐字段冲突合并
 *
 * 与 shell 的接线只需一行（见 `register.ts`）：
 *   `registerVaultHandlers({ manager, sync })`
 */
export * from './credentials'
export * from './errors'
export * from './library'
export * from './manager'
export * from './model'
export * from './register'
export * from './repo'
export * from './secret-box'
export * from './ssh-config-file'
export * from './ssh-config-text'
