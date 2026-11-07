# AGENTS.md

本仓库是「清理构建缓存」弹窗的列表计算模块。

## 约定
- 对外函数签名不得修改：`visibleRange(total, scrollTop, viewportHeight, rowHeight)`。
- 任何行为变化必须同时补回归用例（`test/` 下，`node:test`）。
- 不引入第三方依赖。
- 不改 `README.md` 里的行为说明，除非行为确实变了（那就同时改）。
- 提交信息用中文，首行不超过 50 字。

## 测试
```bash
node --test
```
