# 审计 v3 · 接真实模型的首轮观察

> 审计对象：`hifox-repro`（HiFox / 狄仁杰 复现）
> 审计角度：**把 Mock 摘掉，换成真实 CLI**——前面所有绿灯都建立在「Mock 必然听话」之上，而这恰恰是最不真实的部分。
> 环境：Windows 11 + Node 22.22 + Claude Code 2.1.221（`claude -p`）
> 日期：2026-11-07

---

## 0. 一句话结论

真实模型只用了两轮就拆穿了 7 个「Mock 掩盖的假实现」，其中 1 个是**致命**的：

> **整条链可以在零代码交付的情况下走到「已完成 / 已提测」。**

产物齐、测试绿、状态对、七步全 ok——而仓库里一行提交都没有。这个结论在 Mock 下永远测不出来，因为 Mock 自己会 `commit`。

---

## 1. 审计方法

不看代码猜，而是真的跑：

1. 用独立工作区 `tasks/HF-CLI01`（第 1 轮）与 `tasks/HF-CLI02`（第 2 轮），每次从 `examples/demo-repo` 全新拷贝。
2. `HIFOX_RUNTIME_CMD` 指向真实 `claude`，走同一套 `run / msg / resume / status` 命令。
3. 每次失败都不改模型产物（那是作弊），而是判断：**是模型的问题，还是引擎/适配器的问题**。
4. 只有判为引擎问题时才改代码，改完回到真实模型复跑。

判定标准沿用前两轮：一项功能必须同时满足「存在 → 有调用方 → 有真实效果 → 失败可确定复现」，缺一条就算假实现。

---

## 2. 缺陷清单

| # | 严重度 | 症状 | 根因 | 状态 |
| --- | --- | --- | --- | --- |
| R1 | P0 | 第一步就 `TOOL Runtime 启动失败`，链根本起不来 | `spawn('claude')` 在 Windows 上找不到 npm 垫片；`spawn('claude.cmd')` 又被 Node 禁止 | 已修 |
| R2 | P1 | 报错只有「Runtime 启动失败」，没有 `ENOENT` | 引擎只打印 `err.message`，丢掉了 `ToolError.detail` | 已修 |
| R3 | P0 | 门 1 拒绝了正确的令牌：`Q1 没有选项 A` | 决策表解析器写死「第 2 列必须是 `1A`」，只认 Mock 自己生成的 3 列表 | 已修 |
| R4 | P0 | `VERIFY` 必然失败：缺 `verification/manifest.md` | cli runtime 把**引擎自己生成**的产物算进了模型应交付清单 | 已修 |
| R5 | **P0 致命** | 零提交也能走完七步到「已完成 / 已提测」 | 没有任何地方要求「改动已提交」；Mock 自己 commit，把这条规则一起代办了 | 已修 |
| R6 | P1 | 模型把 `diagnosis.md` / `idea.md` 写进**仓库根目录** | 提示里从头到尾没给工作区绝对路径，模型按 cwd 猜 | 已修 |
| R7 | P1 | 产物齐全、内容也对，却因小节标题措辞不同被反复判不合格 | 必备段落按**字面标题**匹配；真实模型会把「哪些行为保持不变」写进「改动范围」 | 已修 |
| R8 | P2 | 额度耗尽（`402`）被显示成「产物不齐」 | 非零退出码被当成正常结束，stderr 直接被丢掉 | 已修 |

修复 8 项，保留 0 项新增；旧的两项（`REVIEW_BRANCH`、`RETRY_TRANSPORT`）维持「配置存在但未生效」的声明。

---

## 3. 逐项说明

### R1 Windows 上根本 spawn 不起来

`CliRuntime` 原本直接 `spawn(argv[0], argv.slice(1))`。Windows 上 `claude` 是 npm 生成的三件套：

```
claude        ← POSIX sh 垫片，CreateProcess 执行不了
claude.cmd    ← cmd 垫片，Node 18+ 起禁止无 shell 直接 spawn（EINVAL）
claude.ps1
```

而 `claude.cmd` 里写着真实入口：

```bat
"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
```

新增 `src/runtime/exe.ts`：按 PATH 只找 `.exe/.cmd/.bat`（**故意不试无扩展名**，否则会选中那个 sh 垫片），若是垫片则解析出里面被引号包住的真实入口，再交给 `spawn`。解析路径会打印在日志第一行，不让人猜：

```
runtime claude：shim 解析到 C:\Users\...\@anthropic-ai\claude-code\bin\claude.exe
```

### R2 错误里最有用的一句被扔了

`ToolError` 有 `detail` 字段，但引擎只 `trace(err.message)`。用户看到「Runtime 启动失败」，看不到 `spawn claude ENOENT`。现在 `detail` 会拼进消息与事件，`run.log` 里能直接看到原因。

### R3 决策表解析器只认自己写的表

Mock 生成的是紧凑 3 列表：

```
| 1A | 就地修正计算 | ✅ 推荐 |
```

真实模型写的是 7 列：

```
| 编号 | 决策点 | 选项 | 做法 | 影响 | 成本 | 建议 |
| 1 | 起点计算 | 1A | clamp 后夹取 | 满足用例 | 1 行 | ✅ 推荐 |
```

旧解析器固定取 `cells[1]` 当选项键，于是 7 列表里 `cells[1]` 是「1」，匹配不上 `^[1-9][A-Z]$`，整张表解析为空 → 门 1 报 `Q1 没有选项 A`。

**这是典型的「测试自己生成的数据」型假实现**：解析器和 Mock 是同一份约定，双方都觉得对。现在改为「扫描整行，找第一个形如 `1A` 的单元格」，推荐标记也在整行内识别。

顺带把 `cli.ts` 里重复实现的 `countDecisions` 换成同一个解析器——否则页脚「待此决策」和门禁会各算一套。

### R4 让模型交引擎自己的作业

`verification/manifest.md` 的 `owner` 是 `engine`，由引擎在本阶段**成功之后**生成。而 cli runtime 用 `ARTIFACTS.filter(a => a.stage === stage)` 做完工检查，把这份还没生成的引擎产物也算了进去——任何真实 CLI 走到 `VERIFY` 都必然 `BAD_OUTPUT`。改成 `artifactsOfStage(stage).filter(a => a.owner === 'runtime')`。

### R5（致命）零交付也能走到「已完成」

第 1 轮真实链路跑通全程，日志漂亮：

```
IMPLEMENT → REBASE → REVIEW（0 阻断）→ VERIFY（pass 13 / fail 0）→ WAIT_SHIP → SHIP → DONE
提测七步：merge ok / ref_verify ok / retest ok / comment ok / backfill ok / env_stop ok / status ok
```

核对仓库才发现：

```bash
$ git log --oneline
f118fc4 chore: 虚拟列表计算模块初始版本     # 只有初始提交
$ git status --short
 M src/virtualList.js
 M test/virtualList.test.js
```

模型确实改了代码、也写了测试（13 条全绿），但**从未提交**。于是：

- `git rev-parse HEAD` 拿到的是**基线提交**；
- `merge hifox-agent/.../HF-CLI01 → develop` 把 develop 合进 develop，空操作；
- 任务状态照样推成「待测试」，页脚照样写「阶段: 完成」。

交付物是零。这是全套设计里最危险的一类假完成：**每一道闸都通过了，因为它们看的都不是「有没有交付」**。

修复方式不是「引擎替它提交」（那是引擎伪造证据），而是把「提交」变成判据：

```ts
// src/git.ts
export function assertDeliverable(repo, base) {
  // ① 工作树必须干净 ② 分支上必须有超出基线的提交
}
```

- 引擎侧：`IMPLEMENT` / `PATCH` 收到 `CODE_DONE` / `PATCH_DONE` 后立刻校验，不合格 → `STAGE_ERROR` → `PAUSED`。
- 提测侧：`merge` 步骤执行前再校一次（纵深防御），没有可合并的提交就直接拒绝。
- 提示侧：主指令与 `lattice-implement/SKILL.md` 都补上了「收尾必须 `git add -A && git commit`」。

对应验收断言 **⑲**：故意让 Mock「改了不提交」，必须停在 `PAUSED`、原因含「不可交付」、且仓库无新提交。

### R6 产物写进了仓库

第 2 轮出现过 `?? diagnosis.md` / `?? idea.md`（在 repo 根目录）。原因是上下文从头到尾没说过工作区在哪，模型只能按 cwd 猜。

新增上下文块「工作路径」，把三个绝对路径直接摆出来：任务工作区、产物目录、修复仓库，并明说「产物不要写进仓库目录」。加上这条之后，第 2 轮的提交里只有 `src/virtualList.js` + `test/virtualList.test.js` 两个文件，干净。

### R7 「标题写法」变成了隐性通关条件

连续两次，模型交出的 `idea.md` 内容都对（决策表完整、有「不改：签名与调用方式」），却因为没写 `## 哪些行为保持不变` 这个小节标题被判不合格；即使补齐提示明确要求「补上这个标题」，它依然会用自己的措辞。

这说明当时的标准其实在测「你有没有照抄我的标题」，而不是「你有没有说清楚」。

两处改动，方向相反但都必要：

1. **判定放宽到内容**：`SECTION_ALIASES` 收录真实出现过的同义写法（`需要人类拍板` / `需要你决定` / `待决策项`；`签名不变` / `不改` 等）。表里只收实测写法，不收猜测。
2. **流程给一次自纠机会**：`CliRuntime` 在产物不合格时，用同一份提示 + 缺陷清单再跑一轮，上限 1 次（`HIFOX_REPAIR_ROUNDS=0` 可关）。这不是放宽判定——补完仍不合格照样 `BAD_OUTPUT → PAUSED`。

实测这一轮：第一次缺「哪些需要用户选择」，补齐轮 12 秒补上，阶段通过，**没有消耗人工轮次**。

### R8 402 被当成「产物不齐」

额度耗尽时 `claude` 退出码 1，stdout 为空。旧逻辑只在 124/127 上抛错，1 被当作正常结束，然后判「产物不齐」——人去查产物，白跑一趟。现在非零退出会打印退出码与 stderr 尾部（这次就是 `API Error: 402 Insufficient Balance`），并且会拼进最终错误信息。

---

## 4. 两轮真实链路时间线

**第 1 轮（`tasks/HF-CLI01`）** —— 一路修到 `DONE`，也因此暴露出 R5：

| 时间 | 事件 | 阶段耗时 |
| --- | --- | --- |
| 05:00 | `TOOL Runtime 启动失败` → PAUSED | 0.3s |
| 05:01 | 修好 exe 解析后仍 `BAD_OUTPUT`（`idea.md` 缺 2 节） | 90s |
| 05:03 | 人工指出缺失小节 → `WAIT_DEV` | 91s |
| 05:05 | 门 1 拒绝了正确令牌（R3） | 0.4s |
| 05:06 | 修好解析器后 `IMPLEMENT` → `REBASE` | 44s |
| 05:08 | `REBASE` → `REVIEW` | 92s |
| 05:09 | 评审通过（0 阻断） | 75s |
| 05:10 | `VERIFY` 因引擎产物失败（R4） | 77s |
| 05:11 | 修好后 `VERIFY` → `WAIT_SHIP` | 56s |
| 05:12 | `【提测】` → `SHIP` → `DONE` | 0.5s |
| — | **核对发现：零提交**（R5） | — |

**第 2 轮（`tasks/HF-CLI02`）** —— 验证修复，跑到 `REVIEW` 后因额度中断：

| 时间 | 事件 | 阶段耗时 |
| --- | --- | --- |
| 05:43 | `DIAGNOSE` 缺 1 节 → 自动补齐 → `WAIT_DEV` | 40s + 12s |
| 05:44 | `【进入开发】` → `IMPLEMENT` 产出真实提交 | 34s |
| 05:44 | `REBASE` → `REVIEW` 产物缺失 | 1s（此时已 402） |
| — | `PAUSED`：缺 `review-report.md` | — |

第 2 轮的提交是真货：

```bash
$ git log --oneline -1
bc36e32 修复虚拟列表可视区间不随滚动移动
$ git show --stat --oneline HEAD
 src/virtualList.js       |  3 ++-
 test/virtualList.test.js | 12 ++++++++++++
 2 files changed, 14 insertions(+), 1 deletion(-)
$ git status --short
（干净）
```

---

## 5. 回归

```
单测     16 / 16（原 14，新增：7 列决策表解析、交付判据三态）
验收     19 / 19（原 18，新增 ⑲ 交付闸）
demo     终态页脚与原文逐字一致，阶段: 完成
```

新增/修改的代码：

| 文件 | 改动 |
| --- | --- |
| `src/runtime/exe.ts` | 新增。Windows 命令解析（.exe / .cmd / .bat → 真实入口） |
| `src/runtime/cli.ts` | 重写：产物只查 runtime 侧、交付闸、补齐 1 轮、非零退出可诊断 |
| `src/decisions.ts` | 解析器不再假设列位置 |
| `src/artifacts.ts` | `hasSection` + `SECTION_ALIASES`（内容判定） |
| `src/git.ts` | 新增 `commitsAhead` / `assertDeliverable` |
| `src/engine.ts` | 实现/修补完成后校验交付；错误 detail 不再丢失 |
| `src/ship.ts` | merge 前再校验一次可交付 |
| `src/context.ts` | 新增「工作路径」上下文块（绝对路径） |
| `src/runtime/mock.ts` | 新增 `skipCommitOn` 故障注入（模拟「改了不提交」） |
| `prompts/instructions.md`、`lattice-implement/SKILL.md` | 明确要求收尾提交 |
| `scripts/verify-day1.mjs` | 新增 ⑲；`HIFOX_VERIFY_NOCLEAN=1` 让沙箱环境也能跑 |

---

## 6. 没做完的部分

- **提测七步在真实模型下没有实测证据**。第 1 轮虽然走完了七步，但那是零提交的假链路；第 2 轮真的产生了提交，却停在 `REVIEW`（额度耗尽）。所以「真实模型 + 真实提交 + 完整七步」这个组合目前**空白**。这是下一轮第一件要做的事。
- **REVIEW 阶段没被真实模型验证过**（第 1 轮那次评审通过了，但评的是工作树里的未提交改动）。
- **截图证据闸**没被触发：这次改动只碰 `.js` 逻辑文件，按规则不需要页面截图。渲染层改动下的真实表现仍是 Mock 证据。

---

## 7. 这轮最该记住的一条

前两轮审计找的是「写了没人调」「配了没人读」。这一轮暴露的是另一种更隐蔽的假实现：

> **它由 Mock 的配合完成。** Mock 太乖，替引擎做了本该被检查的事（提交、按模板写标题、把产物写对位置），于是检查器从来没被逼到墙角。

所以判断一个「纪律引擎」是否真的成立，只有一个办法：**换一个不配合的、会犯懒的、会理解错的执行者去跑它。** 真实模型不是用来演示效果的，是用来当测试夹具的。
