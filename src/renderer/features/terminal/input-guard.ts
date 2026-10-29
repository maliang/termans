/**
 * 终端输入层的「重复发送」守卫。
 *
 * 背景（t41）：xterm 6 有两个入口把字符交给 `onData`——
 * 1. `keydown`：把 `key` 直接派发出去；
 * 2. `input` 事件（`inputType === 'insertText'`）：把 `event.data` 派发出去，
 *    它靠 `_keyDownSeen` 做守卫：`if (e.data && inputType==='insertText' && (!e.composed || !this._keyDownSeen))`。
 *    而 `_keyDownSeen` 在 `keyup` 时就复位了。
 *
 * 所以只要浏览器把 `input` 事件排在 `keyup` 之后（主线程繁忙、事件批处理、自动化输入都可能造成），
 * 同一个字符就会被发两次：一次来自 keydown、一次来自 input。实测（t41 机制探针）：
 * 手工按 `keydown → keyup → input` 的顺序派发，服务端 PTY 收到 `"xx"` 而不是 `"x"`。
 *
 * 这份守卫不猜时序，只记事实：**上一个由 onData 发出去的单字符**。紧随其后的、带同一个字符的
 * `insertText` 就是刚才那一次按键的浏览器回声，吃掉它。多字符 chunk（粘贴、输入法上屏）一律放行，
 * `insertCompositionText` 等输入法事件也不碰。
 */

export interface InputGuardState {
  /** 上一次 onData 发出去的单字符；多字符或空串时为 null（此时不吃任何 input） */
  readonly pending: string | null
}

export const EMPTY_INPUT_GUARD: InputGuardState = Object.freeze({ pending: null })

/** onData 出口：只有「单个字符」才可能被浏览器回声重复，多字符一律清空守卫。 */
export function noteTerminalData(state: InputGuardState, data: string): InputGuardState {
  if (data.length === 1) return { pending: data }
  // 空串不改判（xterm 不会发空串，但别让一次空数据把守卫清掉误伤下一拍）
  if (data.length === 0) return state
  // 多字符 = 粘贴/输入法上屏/一整段 insertText，之后再来一个同名 insertText 不是回声
  return state.pending === null ? state : EMPTY_INPUT_GUARD
}

/** 判断这条 `input` 事件是否就是刚才那次按键的回声（是则应当拦掉，别让 xterm 再发一遍）。 */
export function shouldSuppressInput(
  state: InputGuardState,
  data: string | null,
  inputType: string | undefined
): boolean {
  if (state.pending === null) return false
  if (inputType !== 'insertText') return false
  return data === state.pending
}
