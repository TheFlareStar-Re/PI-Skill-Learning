# Skill Learning（PI-Desktop 插件）

把 Hermes 式 skill 学习闭环接到 PI-Desktop：会话结束后把可复用流程写成 `SKILL.md`，落在技能界面能扫到的目录。

插件 id：`cn.star.skill-learning` · 当前版本：`0.1.4`

## 安装

1. 下载 [dist/cn.star.skill-learning-0.1.4.piplug](dist/cn.star.skill-learning-0.1.4.piplug)（store-only zip，不要自己再压一遍）。
2. PI-Desktop → 扩展 → 导入插件 → 选该 `.piplug`。
3. 授予高风险权限（含 `agent.extension` / `agent.complete` / `agent.prompt.inject`）。
4. 确认扩展页版本为 **v0.1.4**，路径在 `%USERPROFILE%\.pi-desktop\plugins\installed\`。
5. **新开** Agent 会话后再测（旧会话仍绑旧 sidecar）。

开发加载：扩展 → 加载本地插件 → 选本仓库根目录。同一 id 不要同时挂开发目录和已安装包。

## 写盘位置

| 路径 | 作用 |
|---|---|
| `~/.agents/skills/<name>/SKILL.md` | 现行技能（设置 → 技能能看到） |
| `<project>/.agents/skills/<name>/` | scope 为项目时 |
| `~/.agents/skills/.skill-learning/` | 账本 / 队列（点目录，不是 skill） |

不要写到 `skills/learned/<name>/`：技能界面不扫嵌套目录。

## 行为

1. 前台工具 `skill_manage`（create / patch / write_file / delete）只经插件 Node `fs` 写上述目录。薄稿（缺 When to Use / Procedure 等）会拒收。
2. `before_agent_start` 追加学习说明；另注入 catalog skill `skill-learning`。
3. `/learn` 把蒸馏提示 `sendUserMessage` 进当前会话。
4. 后台：`agent_end` 且本轮工具次数够、且没调用过 `skill_manage` → 队列 → `pi.agent.complete`（`tools: []`）→ `skill-store` 落盘。

关掉设置里的 Enable learning loop 后不再注入、不再入队。

## 打包

```bash
python scripts/pack-piplug.py
```

生成 `dist/<id>-<version>.piplug`（`ZIP_STORED`）。PI 安装器拒 deflate。

## 测试

```bash
node --test src/skill-store.test.js
```

冒烟（新会话）：

1. `skill_manage` 建一份带 When to Use / Procedure / Pitfalls / Verification 的 skill。
2. 过：`pluginVersion` 为 `0.1.4`；文件在 `%USERPROFILE%\.agents\skills\<name>\SKILL.md`；设置 → 技能刷新后可见。
3. 薄稿（三句话、无章节）应返回 `skill too thin`，磁盘上不能出现该 name。

## 许可

仓库 `LICENSE` 为 GitHub 创建时选择的 MPL-2.0。
