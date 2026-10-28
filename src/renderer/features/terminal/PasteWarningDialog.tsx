import type { PasteInspection } from './paste'

/**
 * 多行粘贴确认。
 *
 * 为什么必须拦一下：剪贴板里往往是「一段带换行的脚本」或「从网页复制的多行命令」，
 * 粘进终端等于逐行回车执行。用户以为只是粘贴，实际已经跑了三条命令——这是终端里
 * 最常见、也最难挽回的误操作。所以只要行数 > 1 或结尾带换行，就先问一句。
 *
 * 样式复用 `features/tabs/tabs.css` 的 `.ts-confirm`（与关闭确认框同一套外观）。
 */

export interface PasteWarningDialogProps {
  inspection: PasteInspection
  onConfirm: () => void
  onCancel: () => void
}

export function PasteWarningDialog({ inspection, onConfirm, onCancel }: PasteWarningDialogProps) {
  return (
    <div className="ts-confirm" data-testid="paste-dialog">
      <div className="ts-confirm__panel" role="alertdialog" aria-modal="true" aria-labelledby="paste-dialog-title">
        <h2 className="ts-confirm__title" id="paste-dialog-title">
          粘贴多行内容？
        </h2>
        <p className="ts-confirm__body">
          剪贴板里有 <strong data-testid="paste-lines">{inspection.lineCount}</strong> 行
          {inspection.hasTrailingNewline ? '（且以换行结尾）' : ''}，粘贴后每一行都会被执行。
        </p>
        <pre className="ts-confirm__preview" data-testid="paste-preview">
          {inspection.text.length > 400 ? `${inspection.text.slice(0, 400)}…` : inspection.text}
        </pre>
        <div className="ts-confirm__actions">
          <button type="button" className="ts-btn ts-btn--ghost" data-testid="paste-cancel" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="ts-btn ts-btn--danger"
            data-testid="paste-confirm"
            onClick={onConfirm}
            autoFocus
          >
            仍要粘贴
          </button>
        </div>
      </div>
    </div>
  )
}
