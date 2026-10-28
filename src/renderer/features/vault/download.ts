/** 触发一次本地下载（恢复码导出用）。纯 DOM，不依赖 node。 */
export function downloadTextFile(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 下一帧再撤销，避免某些平台上的 URL 失效早于下载开始
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
