# PI-Desktop 自主学习移植方案

把 Hermes 的 **skill 学习闭环**接到 [PI-Desktop](https://github.com/vastsa/PI-Desktop)，不拷贝 Hermes Python runtime。

PI 已经会**读** Skill（`SKILL.md` + 按需 `Skill` 工具）。缺的是**自己写、自己改、自己清**。本方案用 PI 现有的 `agent.extension` + 插件进程实现这三件事。

---

## 0. 一句话

做一个 PI 插件 `cn.star.skill-learning`：

- 前台：给 Agent 一个 `skill_manage` 工具 + 系统提示 nudge + `/learn`
- 后台：`agent_end` 后用 `pi.agent.complete`（无工具）产出 JSON 补丁，再由 extension 落盘
- 维护：只整理 `learned/` 命名空间里、带 `created_by: agent` 的 skill
- 产物：标准 `SKILL.md`，写到 `~/.agents/skills/learned/`（全局）或 `<project>/.agents/skills/learned/`（项目）

不改 PI 核心、不改 pi-agent-core。能用插件 + trusted extension 做完的，不走 fork。

---

## 1. 非目标

- 不微调模型、不上 RL / GEPA
- 不把 Hermes 的 `skill_manage` / `background_review.py` / Curator 源码移植过来
- 不改 bundled / marketplace / 用户手写 skill（只动 `learned/`）
- 不在 Plan 模式写 skill（PI 插件工具在 Plan 下是禁用的）
- 不把学习结果写进聊天 transcript（后台复盘对用户静默，面板里可审计）

---

## 2. 为什么是插件 + agent.extension，不是其中之一

| 能力 | 插件进程 (`main.js`) | agent.extension (`src/extension.ts`) |
|---|---|---|
| 注册给模型用的工具 | `pi.agent.registerTool`（Agent 模式） | `pi.registerTool`（sidecar 内，更稳） |
| 系统提示注入 | `contributes.skills` 静态、最多 32 个 | `before_agent_start` 可动态注入 nudge |
| 回合结束钩子 | `session:turnEnded` **0.14.8 还没发货** | `pi.on("agent_end")` **现在就能用** |
| 读本轮 transcript | `getLlmContext()` **只在工具执行中有效** | `agent_end` 的 `event.messages` |
| 无工具 LLM 补全 | `pi.agent.complete`（`tools: []`） | 无官方 complete API |
| 写 `~/.agents/skills` | `fs.write` 默认 workspace 作用域；`userSelected` 句柄不持久 | **未沙箱**，可直接 Node `fs` 写技能搜索路径 |
| 设置 / 面板 / 开关 | 有 | 无 UI |
| `/learn` 斜杠命令 | `pi.commands.register`（给用户） | `pi.registerCommand`（进 composer `/` 菜单） |

结论：

- **写盘 + 回合钩子 + 工具 + `/learn`** → 必须放 extension
- **后台 LLM 复盘** → 插件进程 `pi.agent.complete`（无工具、走用户已登录的模型）
- **两边用队列文件通信**（extension 不能调 `pi.agent.complete`，插件进程拿不到 `agent_end`）

`agent.extension` 是高风险权限，安装时用户会确认。这是合理的：学习循环本来就要改 Agent 的 procedural memory。

---

## 3. Hermes → PI 映射

| Hermes | PI 落点 |
|---|---|
| `skill_manage` 工具 | extension `pi.registerTool("skill_manage")` |
| `SKILLS_GUIDANCE` 系统提示 | `before_agent_start` 追加一段短 nudge（≤1.5k 字符） |
| `skill_view` / `skills_list` | **不重复实现**。PI 已有 Skill 工具 + `~/.agents/skills` 发现 |
| `/learn` | extension `pi.registerCommand("learn")`：把本轮改写成蒸馏 prompt |
| `background_review.py` fork | `agent_end` → 队列 JSON → 插件 `pi.agent.complete` → 落盘 |
| `creation_nudge_interval`（默认 10 次工具迭代） | 设置项 `reviewAfterToolCalls` 默认 10 |
| `created_by: agent` + `.usage.json` | `learned/.usage.json`（插件 data + 技能目录各一份） |
| Curator | 插件 `background.service`，默认只做确定性归档，LLM 合并默认关 |
| `skills.write_approval` | 设置项 `writeApproval`：off / notify / confirm |
| Memory vs skill 分工 | 本插件 **只写 skill**。事实/偏好仍走 PI 已有 memory（若有）或不管 |

Skill 文件格式跟 Hermes 一样走 [agentskills.io](https://agentskills.io)。**正文里的工具名必须改成 PI 的**：`read` / `write` / `edit` / `bash` / `grep` / `glob`，不要写 Hermes 的 `terminal` / `skill_view`。

---

## 4. 目录与进程

```
pi-skill-learning/
├── PLAN.md                          ← 本文件
├── manifest.json
├── main.js                          ← 插件进程：complete、service、面板、设置
├── src/
│   ├── extension.ts                 ← sidecar：工具、nudge、/learn、agent_end
│   ├── skill-store.js               ← 校验 + 读写 learned/
│   ├── review-prompt.js             ← 复盘 /learn 提示词（无 Hermes 工具名）
│   └── usage.js
├── skills/
│   └── learning-nudge.md            ← 可选：静态 catalog 条目（短）
├── views/
│   └── library.html                 ← 已学 skill 列表 / 开关 / 最近写入
└── README.md
```

运行时路径：

```
~/.agents/skills/learned/<name>/SKILL.md
~/.agents/skills/learned/<name>/references/
~/.agents/skills/learned/.usage.json
~/.agents/skills/learned/.queue/     ← extension → plugin 的复盘任务
~/.agents/skills/learned/.archive/   ← curator 归档，可恢复

<project>/.agents/skills/learned/    ← 项目作用域（设置可选）
```

插件私有数据（`pi.plugin.getDataPath()`）只放设置缓存、复盘日志、失败任务，**不**当 skill 加载根。PI 只扫 `~/.agents/skills` 和项目 `.agents/skills`。

---

## 5. 组件契约

### 5.1 `skill_manage` 工具（extension）

模型可见的唯一写入口。动作与 Hermes 对齐，但实现是新的：

```
actions: create | patch | write_file | remove_file | delete
```

硬规则：

1. 根目录只能是 `learned/`。其它 skill 一律拒绝。
2. `create`：`name` 小写连字符，≤64；`description` 一句、建议 ≤120 字（PI catalog 上限 240，但目录越短越好）。
3. `patch`：必须本会话先 `read` 过该 `SKILL.md`（用内置 `read` 即可）。extension 记一个 `readSet`；没读过就返回错误，要求先读。
4. 禁止把失败尝试写成「推荐流程」。提示词里写死。
5. 每次成功写入更新 `.usage.json`：`created_by: "agent" | "user"`（`/learn` 算 user）、`use_count`、`last_activity_at`。
6. `delete` 实际是移到 `.archive/`，不真删。
7. 单文件 ≤ 128 KiB（对齐 PI 插件 skill 上限）；`learned/` 下最多 80 个 active skill，超出让模型去 patch 而不是 create。

返回值给模型：`{ ok, name, path, lints[] }`。lints 是劝告，不阻断（description 过长、像一次事故的标题、references 过多）。

### 5.2 系统提示 nudge

`before_agent_start` 追加，控制在 ~800 字，只说三件事：

1. 非平凡流程（多次工具、纠错、用户纠正）用 `skill_manage` 存到 class-level skill。
2. 已有相关 learned skill 就 patch，不要每次新建。
3. 工具名用 PI 的 `read`/`bash`/…；不要写「此工具不可用」这类负向记忆。

不要复制 Hermes 整段 `SKILLS_GUIDANCE`（里面有 `skill_view`、`[SKILL_PRUNED]`，在 PI 上是错的）。

### 5.3 `/learn`

`pi.registerCommand("learn", …)`。

行为（对齐 Hermes `learn_prompt.py` 的形状，不是实现）：

- 用户：`/learn the deploy steps we just did` 或 `/learn https://…`
- 命令 **不自己蒸馏**。它往当前会话塞一条 user 消息（或 `deliverAs: "steer"`）：去读材料，然后 `skill_manage`。
- 材料采集用 Agent 已有工具：`read`/`grep`/`glob`（本地）、bash+curl 或浏览器（若有）。不要在 extension 里再写爬虫。

插件进程再注册一条同名 command，方便命令面板打开「学习」面板。

### 5.4 后台复盘（闭环的核心）

**触发（extension，`agent_end`）：**

同时满足才入队：

- 设置 `enabled && reviewEnabled`
- 本轮 `reason !== aborted`
- 本轮工具次数 ≥ `reviewAfterToolCalls`（默认 10）
- 本轮 **没有** 成功的 `skill_manage`（有就不重复劳动）
- 距上次复盘 ≥ `minReviewIntervalSec`（默认 120）
- 队列深度 < 2（丢掉更旧的，保留最新 transcript 快照）

快照写入 `learned/.queue/<turnId>.json`：

```json
{
  "v": 1,
  "turnId": "...",
  "sessionId": "...",
  "workspace": "...",
  "toolCallCount": 14,
  "createdAt": "...",
  "messages": [ { "role": "user|assistant|tool", "content": "...", "toolName": "..." } ]
}
```

消息合计截断到 **180k 字符**（`complete` 上限 200k，给 system 留空）。工具结果大幅截断，保留名称+尾部错误。

**执行（插件 `background.service`）：**

1. 扫 `.queue/*.json`
2. `pi.agent.complete({ modelKey, system: REVIEW_PROMPT, messages: [{role:"user", content: packedSnapshot}] })`
3. 解析模型输出为操作列表（见下）
4. 把操作写成 `learned/.queue/<id>.ops.json`，extension 下一次 `session_start` **或** 同进程文件 watch 立刻应用

`pi.agent.complete` 约束（必须遵守，不要设计成会撞墙）：

- `tools: []` → 复盘模型 **不能** 自己调 `skill_manage`
- 8 次 / 60s，90s 超时
- system ≤ 32 KiB
- 需要权限 `agent.complete`；`includeSessionContext` **不要开**（它要求 in-flight tool session，复盘时没有）
- `modelKey` 用设置，默认当前会话模型；失败则 `pi.models.list()` 的第一个

**复盘输出协议（强制 JSON，不要散文）：**

```json
{
  "decision": "skip" | "update",
  "reason": "…",
  "ops": [
    {
      "action": "create" | "patch" | "write_file",
      "name": "deploy-staging",
      "old_string": "…",
      "new_string": "…",
      "content": "---\nname: …",
      "file_path": "references/foo.md"
    }
  ]
}
```

`skip` 必须是一等公民。提示词要求：没可复用方法、未解决失败、一次性任务 → skip。不要学 Hermes review prompt 那种 “most sessions produce at least one update”（在 PI 上会制造垃圾 skill）。

**应用写盘：** 由 extension 的 `applyOps()` 走与 `skill_manage` 同一套校验。插件进程不直接写 `~/.agents/skills`（避免绕过 learned/ 守卫）。service 只负责 LLM；落盘仍走 extension。

若 service 跑完时 sidecar 已空闲：extension 用 `fs.watch` 在 agent 进程里盯 `.queue/*.ops.json`，有文件立刻 apply。不依赖下一轮用户消息。

### 5.5 Curator（第三层，可后做）

插件 service，默认 7 天一次：

- 只处理 `learned/` 且 `created_by: agent`
- idle > 14 天 → stale 标记
- idle > 30 天 → `.archive/`
- **永不删除**
- LLM 合并默认关（设置 `consolidate: false`）
- 钉住（pin）的 skill 跳过

---

## 6. 权限与 manifest 骨架

```json
{
  "schemaVersion": 1,
  "id": "cn.star.skill-learning",
  "name": "Skill Learning",
  "version": "0.1.0",
  "description": "Turns finished work into reusable SKILL.md files under learned/.",
  "main": "main.js",
  "contributes": {
    "agentExtensions": ["src/extension.ts"],
    "agentTools": [],
    "commands": [
      { "id": "skill-learning.open", "title": "Skill Learning: Library", "keywords": ["skill", "learn"] },
      { "id": "skill-learning.learn", "title": "Skill Learning: /learn", "keywords": ["learn"] },
      { "id": "skill-learning.review-now", "title": "Skill Learning: Review last turn" }
    ],
    "views": [
      { "id": "library", "title": { "en": "Learned skills", "zh-CN": "已学技能" }, "icon": "book", "entry": "views/library.html", "order": 40 }
    ],
    "services": [{ "id": "reviewer", "label": "Skill review worker" }],
    "settings": [
      { "key": "enabled", "title": "Enable learning loop", "type": "boolean", "default": true },
      { "key": "reviewEnabled", "title": "Background review after long turns", "type": "boolean", "default": true },
      { "key": "reviewAfterToolCalls", "title": "Min tool calls before review", "type": "number", "default": 10 },
      { "key": "scope", "title": "Skill scope", "type": "select", "default": "global", "options": ["global", "project"] },
      { "key": "writeApproval", "title": "Write approval", "type": "select", "default": "notify", "options": ["off", "notify", "confirm"] },
      { "key": "modelKey", "title": "Review model (empty = session model)", "type": "string", "default": "" }
    ]
  },
  "permissions": [
    "agent.extension",
    "agent.complete",
    "agent.tool.register",
    "agent.prompt.inject",
    "background.service",
    "ui.view",
    "notify",
    "models.list"
  ],
  "engines": { "piDesktop": ">=0.14.0" }
}
```

不申请 `fs.write`：全局技能目录不在 workspace 里，host `fs` 也写不稳。写盘走 unsandboxed extension，这是选 `agent.extension` 的原因，README 里写清楚。

`writeApproval=confirm`：apply 前 `ctx.ui.confirm`（extension 斜杠命令路径）或面板里点同意。后台复盘默认 `notify`（toast + 面板记录），避免弹窗打断。

---

## 7. 分阶段交付

### P0 — 能存（约 1–2 天）

可验收：

- 安装 dev plugin，授予 `agent.extension`
- Agent 模式能看到 `skill_manage`
- 手动让模型 `create` 一个 skill，磁盘上出现 `~/.agents/skills/learned/<name>/SKILL.md`
- 新开一轮，PI 的 Skill 目录里能看到它（description 在 catalog）
- 对 `~/.agents/skills` 下非 learned 路径的 create/patch 被拒绝
- `/learn how I just did X` 会插入蒸馏提示，而不是自己写文件

不做：后台复盘、curator、面板。

### P1 — 会偷学（约 2–3 天）

- `agent_end` 计数 + 队列
- service 调 `complete`，解析 JSON，extension apply
- toast：「已写入 skill `deploy-staging`」或「复盘跳过：一次性任务」
- 面板列出 learned skills、最近 20 条复盘日志
- 失败（JSON 坏、超时、RATE_LIMITED）写日志，不重试超过 1 次

验收：故意跑一轮 ≥10 次工具的可复用流程且前台没存 → 90 秒内 `learned/` 出现或明确 skip。

### P2 — 不腐烂（约 1–2 天）

- usage 统计、pin、archive/restore
- 上限 80、重复 create 改成 patch 的 lint
- `writeApproval=confirm`
- 项目作用域 `.agents/skills/learned/`
- 设置里一键暂停（`enabled=false` 后不再注入 nudge、不入队）

### P3 — 可选，不阻塞使用

- LLM consolidate（默认关）
- 等 PI 发出 `session:turnEnded` 后，把队列从「文件 IPC」改成事件（可删 watch）
- 上游 PR：host API `skills.write` 到 `~/.agents/skills`，就可以去掉 unsandboxed 写盘
- 与 Hermes `learned/` 互拷：只拷 SKILL.md，不拷 Hermes 工具名（加一层 rewrite）

---

## 8. 提示词要点（不要照抄 Hermes）

复盘 system prompt 只保留这些信号：

**要写**

- 用户纠正了步骤/格式/偏好
- 非显而易见的可复用手法（命令顺序、环境坑、验证方法）
- 已加载的 learned skill 过时或缺步

**不要写**

- 「某工具坏了 / 不能用」
- 未跑通就结束的尝试序列
- 一次性任务（「总结这个 PR」）
- 已在 PI 内置 Skill / 用户 skill 里的内容
- 带 PR 号、今天日期、具体报错串当 skill 名

**形状**

- class-level 名字：`deploy-staging`，不要 `fix-issue-1842`
- 优先 patch 已有 learned skill
- 新 skill 的 Procedure 必须是可复制命令，且用 PI 工具名

`/learn` prompt 额外要求：先列出将读取的路径/URL，读完再 `skill_manage`；没在材料里出现的 flag 不准编。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 模型每次复盘都造新 skill | skip 一等公民；80 上限；同名必须 patch；名字像事故则 lint 拒绝 create |
| `complete` 无工具，模型在 JSON 里编文件内容 | apply 走同一套校验；patch 必须 old_string 唯一匹配，否则丢弃该 op |
| 复盘污染当前会话 | complete 是 host one-shot，`tools: []`，结果不写回 transcript |
| `session:turnEnded` 未发货 | 用 extension `agent_end`，不依赖插件事件 |
| `getLlmContext` 只在 tool 中 | 快照来自 `agent_end` messages，不调用 getLlmContext |
| 插件 `fs.write` 写不了 `~/.agents` | 写盘只在 extension |
| Plan 模式 | 工具不可用；nudge 写明「仅 Agent 模式保存」 |
| 高风险 `agent.extension` 劝退用户 | README 说明为什么需要；可只开 `/learn` + 手动 skill_manage |
| 与用户手写 skill 撞名 | 物理隔离在 `learned/`；PI 若按 name 去重，create 时加 `learned-` 前缀 **仅当撞名** |
| 提示词注入 / 恶意 transcript | 不把用户消息当指令执行；只抽「可复用步骤」；禁止写 secrets、`.env`、token |
| complete 费率 | 默认 10 次工具才触发；120s 冷却；队列深度 2 |

---

## 10. 验收清单（P1 完成即「移植成功」）

1. 新会话 catalog 能列出 `learned/` 下 skill。
2. 前台 `skill_manage create` 落盘且下一轮可被 Skill 工具加载。
3. 对 `~/.agents/skills/foo`（非 learned）的写入被拒。
4. `/learn` 只插入提示，真正写盘仍走 `skill_manage`。
5. ≥10 工具且前台未存的成功流程，后台 90s 内 skip 或写入，**聊天区无复盘气泡**。
6. 关掉 `enabled` 后不再注入、不再入队。
7. 归档可 restore；无物理 delete。
8. Plan 模式不出现该工具。

---

## 11. 明确不采用的路径

- **只丢一个 `self-improving-agent` SKILL.md**  
  PI 能加载，但没有写工具、没有 `agent_end`，模型经常忘。这是 Claude Code 社区做法，不是 Hermes 闭环。
- **MCP 包一层 Hermes `skill_manage`**  
  工具形状能挂，触发器全在 Hermes runtime，PI 侧不会自动调。
- **fork 一个完整 pi session 当 review agent**  
  Session Orchestrator 的 spawn 会占一个真会话、进侧栏、还要 `availableForSubagents`。对静默复盘过重。
- **改 PI 核心**  
  P3 才考虑 `skills.write` host API。P0–P2 全部插件内完成。

---

## 12. 建议的实现顺序（写代码时按这个拆）

1. `src/skill-store.js`：纯函数校验 + 读写（可单测，不依赖 `pi`）
2. `src/extension.ts`：注册工具 + nudge + `/learn`
3. 手工跑 P0 验收
4. `review-prompt.js` + queue 格式
5. `main.js` service：complete → ops.json
6. extension watch apply
7. `views/library.html`
8. curator 确定性部分

单测不需要 PI：store 校验、patch 匹配、queue 截断、JSON 解析容错。P1 的完整环在真机跑一轮即可。
