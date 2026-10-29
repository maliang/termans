/**
 * 极小互斥队列（FIFO，Promise 链实现）。
 *
 * 为什么需要：`VaultManager` 每次写操作都会把整个密文仓库重写一遍（`manifest.json` + `vault.enc`），
 * 而 git 的 `commit / fetch / checkout / push` 也都在同一个工作目录里跑。两个 IPC 请求同时进来
 * （典型：用户点「连接」后立刻点「推送」）时，`alignFreshFromRemote` 里的 `rmSync` 会删掉另一个
 * 操作正在提交的文件 —— 实测能把 `<userData>/vault` 清到只剩 `.git`，而 sync 仍然返回 ok。
 *
 * 为什么不用 setTimeout 猜时间：那把正确性押在「机器够快」上，负载一高就复发。这里的队列是
 * 结构性的：所有对同一目录的 git 操作排成一条链，前一个 settle 之后才启动下一个。
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  private pending = 0

  /** 当前排队/执行中的任务数（诊断用，测试里也用它证明「真的串行了」） */
  get size(): number {
    return this.pending
  }

  async run<T>(task: () => Promise<T> | T): Promise<T> {
    this.pending += 1
    // 无论前一个任务成功还是失败，下一个都必须能跑（否则一次网络错误会让队列永久卡死）
    const next = this.tail.then(task, task)
    this.tail = next.then(
      () => undefined,
      () => undefined
    )
    try {
      return await next
    } finally {
      this.pending -= 1
    }
  }
}
