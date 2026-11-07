# lattice-guard · 给 AI 编码 Agent 用的纪律引擎

[![CI](https://github.com/whs2007/lattice-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/whs2007/lattice-guard/actions/workflows/ci.yml)

> 让「完成」从一句自述，变成一个第三方可以复算的结论。

源自对 HiFox「狄仁杰」单 Agent 缺陷修复案例的反向工程：依据官方文档（`help.hifox.com/docs`）、真实生产 Agent 配置（`vin568/hifox-configuration`）与公开分享资料，把它重写成**可运行、可验收、可对拍**的实现。

**它不是 HiFox 平台的克隆**（那是闭源 SaaS，复现不了也不该复现），而是那个案例里真正难的那件事：让一个不可信的模型，按纪律把一个 bug 从诊断推到提测——状态只有一个真相源、授权只认固定令牌、产物缺失不许宣称完成、失败只许暂停不许假装成功。

```
零依赖 · Node ≥ 22.18 直接跑 .ts · 不需要模型、不需要网络、不需要账号
```

## 30 秒跑起来

```bash
node src/main.ts demo         # 端到端跑完一次：诊断 → 门1 → 实现 → 评审(阻断) → 修补 → 验证 → 门2 → 提测七步 → 完成
node src/main.ts verify       # 19 条验收断言（门禁 12 条 + 一致性/证据/交付 7 条）
node --test tests/*.test.mjs  # 17 条单元测试
```

想看界面、自己发令牌：

```bash
node src/main.ts dev --reset     # 起工作台 + 驱动，自动停在门 1
# 打开 http://127.0.0.1:4173
# 先点「继续（试验证）」→ 不会前进；再点「1A 2A 3A【进入开发】」→ 一路跑到门 2
```

> `dev` 是长驻进程，会一直占着任务锁。**想重新跑 demo 前先关掉它**，否则新进程会因 `E8 锁竞争` 被拒绝——这是刻意设计，不是 bug。

命令行等价操作：

```bash
node src/main.ts init  --task HF-14690 --fixture examples/demo-task.json
node src/main.ts run   --ws tasks/HF-14690                # 跑到门外就退出
node src/main.ts run   --ws tasks/HF-14690 --wait 60000   # 最多等 60 秒人类消息
node src/main.ts run   --ws tasks/HF-14690 --follow       # 常驻等（等价 --wait 0）
node src/main.ts msg   --ws tasks/HF-14690 --text "1A 2A 3A【进入开发】"
node src/main.ts status --ws tasks/HF-14690
node src/main.ts doctor --ws tasks/HF-14690               # 自检：不变量 / 页脚 / 产物是否还在
node src/main.ts list                                    # 所有任务 + 卡点（⏸ 等人 / ▶ 在跑）
node src/main.ts intel --ws tasks/HF-14690 --q scrollTop  # 代码与历史检索（诊断用的同一套）
node src/main.ts resume --reason "人工核对后恢复"           # 只对 PAUSED 有效
node src/main.ts retry  --reason "修好基线后继续"           # 只对 PARTIAL_SHIP 有效
node src/main.ts serve --port 4173
```

`msg` 投递后会立刻告诉你这条消息**会不会推进**：停在门前而消息末尾没有对应令牌时，它会明说「会被记录，但不会推进阶段」，不用靠等。

## 复现边界（诚实版）

| 层 | 内容 | 本仓库 | 说明 |
| --- | --- | --- | --- |
| L1 引擎 | 状态机、门禁、页脚、产物校验、六轮上限、提测七步幂等 | ✅ **完整实现** | 纯确定性逻辑，行为可对拍 |
| L2 指令 | 主指令 + 7 个 `lattice-*` Skill | ⚠️ **同构重写** | 狄仁杰本人的 Prompt 从未公开，这里按 luke 的骨架与官方 Skill 规范重写，行为会有偏移 |
| L3 平台 | 云端、`hifoxd`、ACP、权限、排队、任务库 | ❌ **不实现** | 闭源。这里用本地假后端 + 单文件工作台复刻外形 |
| — 模型 | 真实 LLM | ⚠️ **可替换** | 默认 `MockRuntime`（确定性产出，让状态机可验证）；`CliRuntime` 可接任意 AI 编程 CLI |

**为什么要 Mock Runtime**：这个项目的难点不是"模型多聪明"，而是"模型不听话时系统还成不成立"。Mock 让这条主链可以被断言，也让你在没有 API Key 时就能验收纪律。

## 目录

```
src/
  config.ts       所有默认值集中在这里（令牌字面量不可改）
  types.ts        账本、事件、任务单的类型
  stages.ts       STAGES + STAGE_LABELS + TRANSITIONS（行为唯一真相源）
  ledger.ts       账本读写、原子落盘、不变量 I1~I8、消息与消费游标
  footer.ts       页脚生成/解析/与账本逐字段比对
  message.ts      令牌解析（必须位于末尾）+ 1A 2A 3A 决策解析
  decisions.ts    idea.md 决策表解析（✅ 推荐 / ⚠️ 高风险 / 📌 折中）
  artifacts.ts    8 个产物登记表、必备段落校验、证据链判定、引擎生成 manifest
  canAdvance.ts   门禁：只做门，不做自动迁移
  engine.ts       主循环、迁移、评审核对、阶段超时、播报、暂停出口、恢复语义
  ship.ts         提测七步（幂等键按 key 判定 + 失败即 PARTIAL_SHIP + 合并回滚）
  stateAxes.ts    四套状态轴隔离（运行状态不许反推任务状态）
  tasks.ts        多任务视图（list / 面板左栏 / 卡点标记）
  events.ts       事件流（只追加；回答「怎么走到这里、谁推的」）
  repoIntel.ts    代码与历史检索（git log / blame 语义 / 全文检索 / 热点）
  context.ts      13 块上下文组装 + 单块预算 + 总预算压缩
  workspace.ts    工作区引导、进程锁、锁归属校验、重置
  runtime/mock.ts 确定性 Runtime（产物引用真实文件与行号）
  runtime/cli.ts  外部 CLI Runtime 适配器（响应阶段超时信号）
  server.ts       零依赖 HTTP（/api/state 含 events 与 tasks）
  main.ts         CLI
ui/index.html     三栏工作台（导航 / 任务详情 / Agent 会话 / 事件流）
prompts/
  instructions.md 主指令（0~9 节：身份/铁律/账本/阶段表/两道门/决策收敛/产物写法/禁止项/失败与暂停/回复格式）
  skills/lattice-*/SKILL.md  7 个阶段技能：diagnose、idea、explore、implement、review、verify、deliver
                            （原文「探索」与「实现」是两个阶段，这里合并进 IMPLEMENT，探索技能随实现技能一起注入）
examples/
  demo-repo/      带真实缺陷的仓库（6 个测试，初始 2 红）
  demo-task.json  任务单与补丁落点
scripts/
  verify-day1.mjs 19 条验收断言
tests/
  unit.test.mjs   17 条单元测试
tasks/HF-14690/   一次运行的全部痕迹（账本、产物、events.jsonl、run.log、repo 工作副本）
```

## 引擎契约

### 状态与出口

| 阶段 | 谁推进 | 关键约束 |
| --- | --- | --- |
| `INIT` | 引擎 | 建分支 `hifox-agent/direnjie/<任务>`，基线按优先级映射（紧急→main / 高优→staging / 默认→develop） |
| `DIAGNOSE` | Runtime | `diagnosis.md` + `idea.md` 必须落盘且含必备段落；上下文里带**真实检索结果** |
| `WAIT_DEV` | **人类令牌** | `【进入开发】` 必须在消息末尾；「继续」「可以」不算授权 |
| `IMPLEMENT` | Runtime | 有代码 diff 才允许走；偏离计划必须写 `plan-delta.md` |
| `REBASE` | Runtime | 工作区脏 → `PAUSED` |
| `REVIEW` | Runtime + **引擎核对** | 报告写「无阻断发现」才算通过；**事件与报告矛盾时以报告为准**并记 `review_mismatch` |
| `PATCH` | Runtime | 只修报告里的问题；`findings.md` 追加而非覆盖 |
| `VERIFY` | Runtime + 引擎 | 引擎跑测试、按真实 diff 判定是否需要截图、生成 `verification/manifest.md`；证据不足 → `PAUSED` |
| `WAIT_SHIP` | **人类令牌** | `【提测】`；不带令牌的意见 = 返工，回到 `REBASE` |
| `SHIP` | 引擎 | 七步幂等；合并失败先 `merge --abort`；任一步失败 → `PARTIAL_SHIP`，**任务状态不变** |
| `DONE` | — | 唯一终态；页脚必须 `等待: 无 / 期望令牌: 无 / 状态: 已完成 / 待批决策: 0 / 技能加载: lattice-deliver` |
| `PAUSED` | 操作员命令 | 聊天令牌无效；`resume --reason` 回到暂停前阶段并留痕 |

### 三道「不信模型」的闸

这个项目真正的价值不在状态图，而在这三处：

| 闸 | 模型的常见做法 | 引擎的应对 |
| --- | --- | --- |
| **产物闸** | 说「搞定了」，但文件没写或只写标题 | `checkArtifacts` 校验存在、非空、必备段落齐；cli runtime 下不齐即 `BAD_OUTPUT` |
| **评审闸** | 说「无阻断」，报告里却写着 `【阻断】` | `readReviewVerdict` 以报告为凭据；矛盾时按报告执行并记 `review_mismatch` |
| **证据闸** | 测试绿了就说验证通过，但 UI 改动没有页面证据 | `checkEvidence` 按真实 diff 判定：渲染层文件 → 必须有 `verification/screenshots/`；否则 `VERIFY_FAIL` |
| **交付闸** | 代码改了、测试绿了、产物齐了，但**没提交** | `assertDeliverable`：工作树必须干净且分支上有超出基线的提交，否则 `改动不可交付` → `PAUSED`。提测第一步 `merge` 只认提交，没提交就合进去的是空气 |

### 页脚（引擎独占生成权）

```
---页脚开始--- 任务ID: HF-14690 轨道: 普通 阶段: 等待进入开发 等待: 【进入开发】 文案: 未触碰 状态: 等待确认 期望令牌: 【进入开发】 评审迭代: 0 待此决策: 3 技能加载: lattice-idea 阶段产物: .xwing-task/lattice/diagnosis.md, .xwing-task/lattice/idea.md ---页脚结束---
```

11 个字段；`待此决策` / `待批决策` 是同一字段的两个显示名——**门 2 之前（含 `WAIT_SHIP`）用前者，进入提测执行之后用后者**，依据是原文三份逐字页脚：`WAIT_SHIP` 仍写「待此决策: 5」，`DONE` 才写「待批决策: 0」。解析器按已知键名切分，不按空格切——因为 `阶段产物` 的值里带 `, `。

`阶段产物` 列的是**当前阶段（或当前门对应的产出阶段）的交付物，不是历史累计**：门 1 列 `diagnosis.md, idea.md`，门 2 与终态列 `ship-summary.md, verification/manifest.md`。这条同样是照原文三份页脚比对出来的，早先的实现错误地累计了全部产物。

### 不变量（违反即停机，绝不带病前进）

| # | 不变量 |
| --- | --- |
| I1 | `history` 末条的 `to` 等于 `stage` |
| I2 | `waiting` / `expected_token` / `状态=等待确认` 三者同生同灭 |
| I3 | 只有 `WAIT_DEV` / `WAIT_SHIP` 允许带等待令牌 |
| I5 | `review_iteration ≤ 6`，且不小于历史修补次数 |
| I7 | 登记过的产物必须存在且哈希未变（防止模型或人手改产物） |
| I8 | `DONE` 必须干净（无等待、无期望令牌、状态已完成） |

## 验收结果

```
阶段 1 验收 · 19 条断言
场景 A · 门禁与产物          ① ~ ⑧   全绿
场景 B · 异常与暂停          ⑨ ~ ⑪   全绿
场景 C · 返工回路            ⑫       全绿（5 次返工后封顶暂停）
场景 D · 一致性与证据       ⑬ ~ ⑱   全绿（评审核对 / 阶段超时 / 幂等键 / 合并回滚 / 证据链 / 多任务）
场景 E · 交付真实性          ⑲       全绿（改了没提交 → 不可交付）
结果：19 通过 / 0 未通过

单元测试：17 通过 / 0 未通过
demo 连跑三次：均到「阶段: 完成」
```

上面这组数字不是本机一次性的截图：CI 每次提交都会在 **Ubuntu 与 Windows** 上重新跑一遍（见徽章），
并且「全新克隆能否直接跑」本身也是验证过的——干净目录里 `git clone` 后直接 `node src/main.ts demo` 即到终态。

## 接真实模型

```bash
# 最小可用（Linux/macOS）
HIFOX_RUNTIME_CMD="claude -p" node src/main.ts run --ws tasks/HF-14690 --runtime cli

# Windows + Claude Code：npm 垫片（.cmd）不能直接 spawn，下面的写法省事也稳
HIFOX_RUNTIME_CMD="claude -p --dangerously-skip-permissions" node src/main.ts run --ws tasks/HF-14690 --runtime cli
```

`CliRuntime` 把上下文写进 `.xwing-task/lattice/prompt-<阶段>.md`，通过 stdin 交给任意 CLI，工作目录是被修复的仓库，提交作者注入成「触发人 & 狄仁杰」。

### 接真实模型必须知道的四件事（都是实测踩出来的）

1. **必须给足工具权限**。只给 `--allowedTools "Bash(git:*)"` 时，模型会告诉你「git 被权限系统拦截」，然后**不提交**。引擎会因此判「改动不可交付」并暂停——不是模型不听话，是它没有权限。
2. **Windows 上命令要能真的 spawn**。npm 全局装的 CLI 是 `.cmd` 垫片，`spawn('claude')` 找不到、`spawn('claude.cmd')` 又不被 Node 允许。`src/runtime/exe.ts` 会按 PATH 找 `.exe/.cmd/.bat`，并从垫片里挖出真实入口（本例解析到 `...\claude-code\bin\claude.exe`）。解析路径会打印在日志第一行。
3. **产物不合格时允许同阶段补齐 1 次**（`HIFOX_REPAIR_ROUNDS=0` 可关闭）。真实模型常把小节标题换个说法，或把产物写进仓库根目录。补齐是把提示原样再喂一遍、附上具体缺陷清单；补完仍不合格就照旧 `BAD_OUTPUT → PAUSED`。**上限只有 1 次，不消耗人工轮次，也不改动阶段判定标准**。
4. **「完成」看提交，不看工作树**。模型改完代码不 `git commit` 是最常见的假完成：产物齐、测试绿、状态能推到「已提测」，而 `merge` 合进去的是空气。交付闸会拦下它。

### 它不信任什么

阶段是否完成，由产物校验器判定（文件存在、非空、必填内容齐、改动已提交）。模型说「搞定了」而产物不在，就是 `BAD_OUTPUT` → 暂停。

必备段落按**内容**而非措辞判定：`哪些行为保持不变` 也认「签名不变 / 不改」这类写法（同义表见 `artifacts.ts::SECTION_ALIASES`，只收真实跑出来过的写法）。

阶段超时会通过 `AbortSignal` 传给 Runtime；`CliRuntime` 收到后 `SIGKILL` 子进程，不留孤儿。模型进程非零退出（额度用尽、鉴权失败）不会被当成阶段错误，但会把退出码与 stderr 尾部写进日志，避免把「模型根本没跑起来」误诊成「产物没写」。

## 零成本跑真实模型

Claude 账号 `402 Insufficient Balance` 之后，这条链还能靠**厂商官方免费档**继续跑，不需要充值，也不需要去捡别人泄露的 Key。

### 先避开一个流传很广的错配

网上大量文章说「把 `ANTHROPIC_BASE_URL` 指到 Groq / Gemini 就能白嫖 Claude Code」。**不成立**：Claude Code 官方网关文档写明该变量只接受 Anthropic Messages 格式（`/v1/messages`），而 Groq / 智谱 / OpenRouter 是 OpenAI 格式。直接指过去会失败，中间必须加协议转换网关（Claude Code Router、LiteLLM 一类）。

### 先确认网络：这台机器的实测结果（2026-11-07）

**连通性是会变的**，别照着旧结论直接跑长链。代理与直连各测一次：

| 端点 | 走代理 | 直连 | 结论 |
|---|---|---|---|
| `open.bigmodel.cn` | 401 / 0.16s | 401 / 0.14s | ✅ 可用（401 = 只差 Key） |
| `api.siliconflow.cn` | 401 / 0.22s | 401 / 0.22s | ✅ 可用 |
| `openrouter.ai` | 200 / 7.0s | 200 / 4.2s | ✅ 可用，但慢 |
| `api.groq.com` | 403 | 403 | ⚠️ TCP 通，被 WAF 挡 |
| `generativelanguage.googleapis.com` | 000 | 000 | ❌ 完全不通 |
| `api.mistral.ai` | 000 | 000 | ❌ 完全不通 |

跑之前花 10 秒预检一次：

```bash
curl -sS -m 10 -o /dev/null -w "%{http_code}\n" https://open.bigmodel.cn/api/paas/v4/models
# 401/403/200 都说明链路通；000 或超时就换厂商或修代理
```

### 现成可用的组合

| 路线 | 免费额度（以厂商页面为准） | 要信用卡 | 本项目接入 |
|---|---|---|---|
| **智谱 GLM Flash**（推荐） | 免费模型，国内直连 | 否 | `scripts/runtime-openai.mjs`，无需装任何 CLI |
| 硅基流动 | 部分模型免费 | 否 | 同上，换 `HIFOX_OPENAI_BASE` / `MODEL` |
| OpenRouter `:free` | 约 50 次/天 | 否 | 同上，额度偏紧、延迟高 |
| Groq | 约 1,000 次/天 | 否 | 同上，但本机 403 |
| Gemini API Key | 免费档每日数百次 | 否 | `scripts/runtime-gemini.mjs`，**这台机器当前端点不通** |
| Gemini CLI + Google 账号 OAuth | 1,000 次/天，免 Key | 否 | **不适用**：headless 下 Y/n 确认会抢走 stdin（实测认证被取消） |

### 路线 A：OpenAI 兼容端点（推荐 · 当前链路可达）

在厂商控制台拿一个免费 Key（智谱 https://bigmodel.cn/usercenter/apikeys 、硅基流动、或 OpenRouter），然后：

```bash
export HIFOX_OPENAI_KEY="你的免费key"
export HIFOX_RUNTIME_CMD="node scripts/runtime-openai.mjs"
node src/main.ts run --ws tasks/HF-14690 --runtime cli

# 换厂商时同时改 BASE 和 MODEL，例如 OpenRouter
export HIFOX_OPENAI_BASE="https://openrouter.ai/api/v1"
export HIFOX_OPENAI_MODEL="meta-llama/llama-3.1-8b-instruct:free"
```

`runtime-openai.mjs` 零依赖，只用 Node 原生 `fetch`：把 stdin 的 12 块上下文作为 user 消息，交给 `/chat/completions`，暴露 `read_file` / `write_file` / `run_cmd` 三个工具，循环到模型不再调用工具为止。

刻意的边界：

- **文件只能写进仓库或 `HIFOX_WS`**，绝对路径与 `../` 逃逸都挡掉；
- **模型说「完成」不算完成**，退出后仍由引擎的产物校验器裁决；
- **任何 401/402/429/网络错误立即非零退出**，不静默重试；引擎会把退出码与 stderr 尾部写进 PAUSED 原因；
- 子进程里的相对脚本路径由 `CliRuntime` 自动按项目根绝对化（子进程 cwd 是 `<ws>/repo`，写相对路径会 `MODULE_NOT_FOUND`）。

> 已验证到哪一步：无 Key / 假 Key 打智谱与 OpenRouter 都在 **1 秒内**返回明确的 401，引擎 `PAUSED` 的原因直接带上「令牌已过期」，不伪装成产物问题。**尚未用有效 Key 跑完整条链**——免费档能不能走完提测七步，仍缺实测证据。

### 路线 B：Gemini API Key（换网络后才可用）

去 https://aistudio.google.com/apikey 生成免费 Key，然后：

```bash
export GEMINI_API_KEY="你的免费key"
export HIFOX_RUNTIME_CMD="node scripts/runtime-gemini.mjs"
node src/main.ts run --ws tasks/HF-14690 --runtime cli
```

适配器把长 prompt 走 stdin（`gemini -p` 会把 stdin 追加到参数后），用 `--include-directories $HIFOX_WS` 挂上工作区（**否则产物会被写进 repo 根目录**），`--yolo` 自动批准写文件与 git。可选 `HIFOX_GEMINI_MODEL=gemini-2.5-flash` 跳过内部路由那次额外请求。

两个实测踩出来的坑都处理了：Gemini CLI 鉴权失败时**退出码仍是 0**；网络不通时它打印 `fetch failed sending request` 后**无限退避重试，进程不退出**。现在边读 stderr 边判定，遇到不可恢复错误立刻杀进程树并非零退出（Windows `shell:true` 下只 `child.kill()` 杀不掉子进程树，必须 `taskkill /T /F`），另有 `HIFOX_ADAPTER_TIMEOUT_SEC`（默认 180s）兜底。

一轮完整链大约几十次请求，免费日额度够跑好几轮。**免费档通常允许厂商用提示词改进产品**，别把私有代码或客户数据喂进去。

## 已知限制

- **Mock Runtime 不会思考**。它按 `examples/demo-task.json` 里的补丁落点确定性地产出产物与代码改动；产物的文件路径、行号、符号名、提交历史全部来自真实仓库检索，但它对「根因」的表述仍是模板化的。用途是验证纪律，不是验证智能。
- **Skill 内容是同构重写**。7 个技能的**名字与原文一致**（diagnose / idea / explore / implement / review / verify / deliver），但正文是按官方 Skill 规范仿写的，不是原文。
- **「探索」没有独立阶段**。原文里探索与实现是两个阶段、两个技能；本复现把它们合进 `IMPLEMENT`，页脚「技能加载」仍只显示 `lattice-implement`，探索技能只是随上下文注入。要完全对齐需要拆出一个 `EXPLORE` 阶段，会改动 `TRANSITIONS`。
- **提测评论没有附件**。原文是「发任务评论（带附件）」，这里把 `ship-summary.md` 正文写进 `comments.jsonl`，没有真正的附件对象。
- **任务状态字段中英混用**。`task.json` 的 `status` 默认值是 `In Progress`（照抄早期代码），提测后改成 `待测试`。原文的任务状态取值未在资料中出现，所以没有强行统一。
- **工作台是假后端**。任务列表、看板、收件箱只有外壳，数据来自本地 `task.json` 与账本；左栏的「其他任务」只读，切任务需要重启 `dev --ws`。
- **提测目标是本地 `develop`**。真实环境应合并到远端并通过平台 API 回填字段；这里用 `task.json` 的 `custom_fields` 模拟，写入遵循 `### Agent 记录` 整段覆盖协议。
- **`REVIEW_BRANCH` 未启用**。配置项保留但没有任何代码使用——「专用远端评审分支」这条设计没有实现，别以为它生效了。
- **`RETRY_TRANSPORT` 恒为 0**。零自动重试是刻意的（自动重试会掩盖 `PAUSED` 语义）；要开必须同时记 `retry` 事件，目前没实现。
- **真实模型只跑到 `REVIEW` 就打住了**。第二轮真实链路（`tasks/HF-CLI02`）已证明：诊断→门 1→实现（真实提交 `bc36e32`，+14 −1）→变基→评审，之后账号额度耗尽（`402 Insufficient Balance`）。所以「真实模型能不能走完提测七步」目前**没有实测证据**，Mock 走完过。

审计过程与修复记录见 `AUDIT.md`（功能完整性）、`AUDIT_v2_可用性与复现性.md`（可用性与复现性）、`AUDIT_v3_真实模型首轮.md`（接真实 CLI 的首轮观察）。
