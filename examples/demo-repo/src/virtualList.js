/**
 * 弹窗内列表的可视区间计算。
 * 纯函数，不依赖 DOM，便于回归。
 *
 * @param {number} total           列表总行数
 * @param {number} scrollTop       当前滚动偏移（px）
 * @param {number} viewportHeight  可视区高度（px）
 * @param {number} rowHeight       单行高度（px）
 * @returns {{start: number, end: number}} 半开区间 [start, end)
 */
export function visibleRange(total, scrollTop, viewportHeight, rowHeight) {
  const start = 0;
  const count = Math.ceil(viewportHeight / rowHeight);
  return { start, end: Math.min(total, start + count) };
}

/** 是否已经滚到底部 */
export function atBottom(total, scrollTop, viewportHeight, rowHeight) {
  const { end } = visibleRange(total, scrollTop, viewportHeight, rowHeight);
  return end >= total;
}
