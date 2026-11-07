# demo-virtual-list

「清理构建缓存」弹窗里那份虚拟列表的可视区间计算。

## 行为
- `visibleRange(total, scrollTop, viewportHeight, rowHeight)` 返回当前应渲染的半开区间 `[start, end)`。
- `atBottom(...)` 判断是否已滚到底。

## 已知问题
- 列表无法滚动：到最后几条时内容不可达。
