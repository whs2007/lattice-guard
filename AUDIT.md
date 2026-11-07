# 审计报告 · 功能完整性

审计对象：`hifox-repro`（复现《项目复现规格书》的可运行实现）
审计基准：《项目复现规格书》第 2 章 P0 功能地图（16 项 + 2 项推断）、第 6 章 AI 核心链路、`项目复现规格书_v3_GitHub核验修订.md`
审计方式：**不以代码注释和自我汇报为准**，逐项对照「功能是否存在 → 是否能被触发 → 触发后是否真的产生效果 → 失败时是否有确定行为」
审计时间：2026-11-06

---

## 0. 结论摘要

| 项 | 结果 |
| --- | --- |
| 审计范围 | 18 项 P0 功能 / 37 个函数导出 / 6 条 CLI 主路径 |
| 发现缺陷 | **16 项**：严重 7、中等 6、轻微 3 |
| 已修复 | **14 项**（含 2 项运行时暴露的并发缺陷） |
| 未修复（有意保留） | 2 项（`REVIEW_BRANCH`、`RETRY_TRANSPORT`），已在 README「已知限制」声明 |
| 修复后验收 | 18 / 18 断言通过（47 秒）；11 / 11 单测通过；`demo` 连跑三次均到 `阶段: 完成` |

**最重要的一条**：这个项目原来的通过率是「看起来全绿」。12 条断言全绿、demo 能跑完，但其中至少 6 条 P0 功能的实现是**写在纸上、没有接上**——配置项定义了没人读、校验函数写了没人调、产物内容是编的。这类问题跑测试跑不出来，只能逐条追「谁调用了它」。

---

## 1. 审计方法

对每个 P0 功能问四个问题，任一答不上即记为缺口：

| # | 问题 | 判据 |
| --- | --- | --- |
| Q1 | 功能存在吗 | 有对应函数/命令/代码路径 |
| Q2 | 谁触发它 | 有调用方（不是只定义未使用） |
| Q3 | 触发后有真实效果吗 | 效果可观测（文件变化、账本变化、事件、返回值） |
| Q4 | 失败时有确定行为吗 | 错误分支有明确落点，不是静默通过 |

辅助手段：

```bash
# 找「定义了但没人用」的配置与函数
for k in STAGE_TIMEOUT_SEC MAX_CONTEXT_CHARS RETRY_TRANSPORT REVIEW_BRANCH; do
  printf "%-22s " "$k"; grep -rn "$k" src/ --include=*.ts | grep -v "config.ts:" | wc -l
done

# 找「写了但没接」的导出
for f in reviewIsClean stageToRun projectRunToTask assertFooterMatchesLedger; do
  printf "%-28s " "$f"
  grep -rn "$f" src/ scripts/ tests/ | grep -v "export function $f" | wc -l
done
```

---

## 2. 缺陷清单

### 严重（P0 功能不闭合）

#### F1 · 评审结论无人核对 —— `reviewIsClean` 写了从未被调用

| 项 | 内容 |
| --- | --- |
| 现象 | `src/artifacts.ts` 导出了 `reviewIsClean`，但 `engine.ts` / `stages.ts` / `runtime/*` 都**没有引用它**。Runtime 返回 `REVIEW_CLEAN` 时，引擎直接放行。 |
| 后果 | 模型只要在事件里说「0 阻断」，哪怕 `review-report.md` 写着 10 项 `【阻断】`，也会直接进入 `VERIFY`。净室评审这道 P0 功能形同虚设。 |
| 判定 | 违反 Q3（触发后无真实效果）与 Q4（矛盾时无行为） |
| 修复 | 新增 `readReviewVerdict()`（以报告为唯一凭据，判「阻断项」小节）+ `engine.reconcileReview()`：事件与报告矛盾时**以报告为准**，并记 `review_mismatch` 事件。`CliRuntime` 也改用同一判读规则。 |
| 验证 | 断言 ⑬：构造「事件 CLEAN + 报告 2 项阻断」，确认进了 `PATCH` 且事件流有 `review_mismatch` |

#### F2 · 阶段级超时不存在 —— `STAGE_TIMEOUT_SEC` 零使用

| 项 | 内容 |
| --- | --- |
| 现象 | `config.ts` 定义了 `STAGE_TIMEOUT_SEC: 5400`，全仓除定义外**零引用**。 |
| 后果 | 一个阶段可以把引擎永久挂住。资料里明确「几十个实例无人值守跑几十分钟」，没有阶段超时等于没有失败判定。 |
| 修复 | `engine.runStageWithTimeout()`：`AbortController` + `Promise.race`；`RuntimeCtx` 增加 `signal`；`CliRuntime` 监听 abort 后 `SIGKILL` 子进程（否则只是「引擎不等了」，进程变孤儿）。超时一律落 `PAUSED` 并记 `stage_timeout`。 |
| 验证 | 断言 ⑭：用一个永不 resolve 的 Runtime，`STAGE_TIMEOUT_SEC=0.15`，确认进 `PAUSED`、状态不是「已完成」、事件流有 `stage_timeout` |

#### F3 · 提测幂等键没真正生效 —— 按 seq 跳过，不按 idem_key

| 项 | 内容 |
| --- | --- |
| 现象 | `ship.ts` 原逻辑：`if (rec && rec.status === 'ok') continue;` —— 只看步号，不看键。 |
| 后果 | 修补后 commit 变了，`merge:{task}:{commit}` / `retest:{task}:{commit}` 已经与上次不同，但续跑仍会跳过它们，等于用旧结果冒充新结果。 |
| 修复 | 改为按键判定：同键跳过；键变了把该步重置为 `pending` 并记「幂等键变更，重跑」，随后真实执行。 |
| 验证 | 断言 ⑮：同 commit 重跑不失败；换 commit + 不存在的分支，必须**失败在 merge**（旧逻辑会跳过 merge 而失败在 ref_verify） |

#### F4 · 合并失败不回滚 —— 仓库停在 MERGING，重试永远救不回来

| 项 | 内容 |
| --- | --- |
| 现象 | `ship.ts` 内部自建的 `gitMerge()` 在合并失败后不 `merge --abort`；`git.ts` 里原有的 `mergeInto()` 甚至用 `mustGit(['checkout', back])` 收尾——冲突时这一步本身就会抛错。两份重复实现，都不可靠。 |
| 后果 | 一次合并冲突后仓库进入 MERGING 状态，`PARTIAL_SHIP → SHIP` 续跑时第一个 git 命令就失败。资料的「提测部分完成，修好后重试」路径断掉。 |
| 修复 | 统一到 `git.mergeInto()`：失败即 `merge --abort`，极端情况 `reset --hard HEAD` 兜底，最后回原分支；删除 `ship.ts` 内的重复实现；`ToolError` 里明示「已回滚/回滚失败」。 |
| 验证 | 断言 ⑯：合并不存在的分支后，`git status --porcelain` 为空、无 `MERGE_HEAD` |

#### F5 · 代码与历史检索缺失 —— P0 第 15 项完全没有实现

| 项 | 内容 |
| --- | --- |
| 现象 | 全仓没有 `git log` / blame / 全文检索能力；`diagnosis.md` 的「证据来自何处」由 Mock 模板写死。 |
| 后果 | 诊断阶段无法「定位到具体文件、引用引入问题的历史工单」，只能让模型凭空猜。这是规格书列为 P0 的能力。 |
| 修复 | 新增 `src/repoIntel.ts`：最近提交、历史工单号统计、改动热点、文件历史、`git grep` 全文检索、关键词抽取、渲染成 Markdown。接入 `context.ts`（第 8 块「代码与历史检索」，24k 预算）与 CLI（`node src/main.ts intel --q`）。 |
| 验证 | `intel` 命令输出真实提交、`HF-14690` 出现 2 次、`src/virtualList.js` 3 次热点；上下文文件含该块 |

#### F6 · 证据链写死假结论

| 项 | 内容 |
| --- | --- |
| 现象 | `writeVerificationManifest()` 无条件写「截图：本轮无 UI 改动，无需同气泡截图」。 |
| 后果 | 无论改了什么，证据索引都声称不需要截图。规格书「UI 改动必须截图并贴进会话」这条 P0 要求被一句固定文案消解。 |
| 修复 | `checkEvidence()` 按**真实 diff** 判定：`needsScreenshot()` 认 tsx/jsx/vue/svelte/css/html 与 `components|pages|views|ui` 路径；渲染层改动必须有 `verification/screenshots/*.png`，否则 `VERIFY_PASS` 被改写成 `VERIFY_FAIL`。manifest 里列出真实改动文件与判定理由。 |
| 验证 | 断言 ⑰：`src/components/List.tsx` 无图 → 拦；补图 → 过；`src/virtualList.js` → 不要求截图 |

#### F16 · 上下文总预算的常量根本不存在，压缩逻辑反而把上下文撑大（补录）

| 项 | 内容 |
| --- | --- |
| 发现方式 | **运行时暴露**：面板联动测试时，事件流里出现 8 次 `context_trim`，而当时的上下文只有 6 千字符——远不该触发压缩。 |
| 根因 | 压缩逻辑引用了 `CFG.MAX_CONTEXT_CHARS`，但 `config.ts` 里**从来没有这个键**。`total <= undefined` 恒为 `false`，于是每轮都进入压缩分支；而压缩的实现是「加一行说明 + `clip`」，当原块只有 79 字符时 `clip` 不裁，加说明反而变成 133 字符。结果：**该防溢出的代码在生产每一条上下文**。 |
| 后果 | 每轮上下文被无谓改写、体积变大；`context_trim` 事件被噪声填满，真正的溢出反而看不出来。这类 bug 不会让任何断言失败——它只是让系统悄悄变差。 |
| 修复 | ① `config.ts` 补上 `MAX_CONTEXT_CHARS: 600000`（依据写在注释里）；② 压缩前判断 `before <= keep` 直接跳过；③ 压缩结果比原来长就回退；④ `clip()` 兜底：裁剪结果更长时直接硬截断。 |
| 验证 | `demo` 后 `context_trim` 事件归零；prompt 文件恢复 11~18k |

---

### 中等

#### F7 · 锁能被 reset 删掉，两个 driver 同时写同一个账本| 项 | 内容 |
| --- | --- |
| 发现方式 | **运行时暴露**：`demo` 突然停在 `PARTIAL_SHIP`，日志里同一条人类消息被处理两次、同一毫秒两次 `WAIT_SHIP → SHIP`。 |
| 根因 | 锁是「文件存在 + pid」实现的；`resetWorkspace()` 会删掉整个 `.xwing-task/`，包括 `.lock`。于是新 driver 拿到新锁，旧 driver 还以为自己独占。再加上一份残留的 `dev` 进程在跑同一个工作区，两边同时写 `state.json` 与仓库 index，最终把工作树搞脏、merge 失败。 |
| 修复 | ① `assertLockOwned()` 每轮循环校验「锁文件的 pid 是否还是自己」，不是就立即抛 `LOCK_LOST` 退出；② `releaseLock()` 只删自己持有的锁；③ `resetWorkspace()` 先 `assertNoLiveDriver()`，有活的别的 driver 就拒绝重置。 |
| 验证 | `demo` 恢复为 `阶段: 完成`；再启动 `dev` 后另起 `demo` 会被 `E8 锁竞争` 拒绝 |

#### F8 · Mock 产物在编造仓库里不存在的东西

| 项 | 内容 |
| --- | --- |
| 现象 | `runtime/mock.ts` 的诊断/方案/探索/评审产物里出现 `src/cart.js`、`total(items)`、`quantity ?? 1`、「滚动高度差 312px」——而 demo 仓库是 `src/virtualList.js`，根本没有 cart.js，也没有这个测量。 |
| 后果 | 产物校验器只查段落标题，查不出内容是假的。**这是最容易骗过验收的一类缺陷**：断言全绿，产物全是编的。 |
| 修复 | 新增 `fact()`：主改动文件取 `patch_ops[0].file`，符号名取首个 `export function`，行号用真实 `locate()` 定位，调用点用 `searchCode()`，历史用 `fileHistory()`。全部文案改为引用这些真实值；无法定位时输出「未定位到具体行，以下为待验证假设」而不是编一个。 |
| 验证 | `diagnosis.md` 现在写 `src/virtualList.js:12 → const start = 0;`；`findings.md` 列真实测试文件；`review-report.md` 的阻断项指向 `visibleRange` 与 `start > end` |

#### F9 · PATCH 覆盖 IMPLEMENT 的 findings.md

| 项 | 内容 |
| --- | --- |
| 现象 | 修补轮把 `findings.md` 整段重写，上一阶段的探索记录丢失，而 `history` 里记过它的哈希。 |
| 修复 | 改为追加「修补轮读过的文件」小节。 |
| 验证 | demo 跑完后 `findings.md` 同时含初轮与修补轮两节 |

#### F10 · 上下文总预算无人管

| 项 | 内容 |
| --- | --- |
| 现象 | 每块有自己的预算，但总和不设上限；`MAX_CONTEXT_CHARS` 零引用。 |
| 修复 | 单块裁剪后做总量检查，超限按「会话历史 → 运行证据 → 代码改动 → 前序产物 → 代码与历史检索 → 仓库规范」顺序压缩，并记 `context_trim` 事件（块号、原长、现长）。 |
| 验证 | 断言集不直接覆盖（阈值需构造超大产物），事件类型已就位，可通过 `events.jsonl` 自查 |

#### F11 · 没有多任务视图

| 项 | 内容 |
| --- | --- |
| 现象 | 只能 `--ws` 一个个查；`stateAxes.stageToRun` 写了没人用。 |
| 修复 | 新增 `src/tasks.ts`：`summarizeTask` / `listTasks` / `formatSummary`，投影出运行状态轴、任务状态轴、交接状态、`needs_human`、`driver_pid`。接入 `list` 命令、`/api/state`（`tasks` 字段）、面板左栏「其他任务」与「活动」页的事件流。 |
| 验证 | 断言 ⑱：`PAUSED` 标卡点且 `run_status=failed`，`INIT` 不标 |

#### F12 · 没有事件流，无法回答「谁推的」

| 项 | 内容 |
| --- | --- |
| 现象 | 只有 `state.json`（快照）与 `history`（迁移），没有「引擎/人/操作员各做了什么」的流水。 |
| 修复 | 新增 `src/events.ts`，16 类事件：阶段进出、门等待/拒绝/接受、方案精化、返工、评审核对不一致、暂停/恢复、提测步骤、上下文压缩、锁竞争等。只追加，写失败不影响主流程。面板「活动」页分两区展示事件流与迁移记录。 |
| 验证 | demo 一次产生 `stage_enter 8 / stage_exit 9 / gate_wait 2 / gate_reject 1 / gate_accept 2 / ship_step 7` |

### 轻微

| # | 问题 | 修复 |
| --- | --- | --- |
| F13 | `ship.ts` 与 `git.ts` 各有一份 merge 实现，行为不一致 | 删除 `ship.ts` 的重复实现，统一到 `mergeInto` |
| F14 | 缺少 Compare 链接，只有分支名（S16/S18 都有「对比」链接） | `git.compareUrl()`：识别 github/gitlab/gitee 远端生成链接；**没有 Web 远端时明确降级为「仅记录分支名」，不编造链接** |
| F15 | `main.ts` 的 `doctor` 分支缩进错位、`tmp/_ui_check.mjs` 残留 | 整理并与 `.gitignore` 对齐 |

---

## 3. 有意保留未修的两项

| 缺口 | 为什么保留 | 已声明的风险 |
| --- | --- | --- |
| `REVIEW_BRANCH` 未启用 | 「专用远端评审分支」需要真实远端与多机环境，本地复现里没有对应物；实现它只能造假 | README「已知限制」明写「别以为它生效了」 |
| `RETRY_TRANSPORT` 恒为 0 | 零自动重试是设计决定：自动重试会把「异常」伪装成「慢」，掩盖 `PAUSED` 语义。要开必须同时提供 `retry` 事件，目前没做 | 同上 |

这两项**不进入 Part F 式「假闭合」**：配置项留在那里只是保留设计意图，文档已明确说它不生效。

---

## 4. 修复后的验收

```
$ node scripts/verify-day1.mjs
阶段 1 验收 · 18 条断言
场景 A · 门禁与产物    ① ~ ⑧   全绿
场景 B · 异常与暂停    ⑨ ~ ⑪   全绿
场景 C · 返工回路      ⑫       全绿（5 次返工后封顶暂停，迭代 6/6）
场景 D · 一致性与证据  ⑬ ~ ⑱   全绿
结果：18 通过 / 0 未通过（共 18 条）

$ node --test tests/*.test.mjs
# pass 11 / # fail 0

$ for i in 1 2 3; do node src/main.ts demo | grep '阶段: '; done
阶段: 完成
阶段: 完成
阶段: 完成
```

---

## 5. 审计遗留观察（不影响当前验收，但值得知道）

| 观察 | 说明 |
| --- | --- |
| 断言覆盖的是「引擎行为」，不是「模型质量」 | Mock Runtime 的产物现在引用真实文件，但它对根因的表述仍是模板。换成真模型后，`readReviewVerdict` / `checkEvidence` 仍能拦住「口是心非」，但拦不住「方向错了但写得很像」。 |
| 面板只读多任务 | 左栏能看到其他任务的卡点，但切换需要重启 `dev --ws`。做路由要引入 URL 状态与多 driver，超出本轮「功能完整性」范围。 |
| 提测副作用是本地模拟 | 评论写 `comments.jsonl`、字段回填写 `task.json`、环境停止写 `env.json`。七步的顺序、幂等、失败停点是真的，副作用对象是假的。 |
| `git blame` 只做到文件级 | `repoIntel` 提供文件历史与全文命中行号，没有做逐行 blame 归属。够用于「这个文件最近被谁因为什么改过」，不够用于「这一行是谁写的」。 |
