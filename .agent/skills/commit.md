---
name: commit
version: 1.0.0
author: Token炼金师
description: 用 git 提交当前改动——自动看 diff、生成 commit message、提交
tags: [git, 提交]
args:
  - name: message
    description: 自定义提交信息（留空则自动生成）
    required: false
---

## 指令

将当前工作区的改动提交到 git。自动查看 diff，生成简洁的中文 commit message。

## 步骤

1. 用 run_command 执行 `git status -s` 查看改动概览。
2. 用 run_command 执行 `git diff --cached` 查看暂存区；若暂存为空则先 `git add -A` 再看 diff。
3. 根据 diff 总结改动内容：
   - 若用户提供了自定义 message 则使用它
   - 否则生成简洁的中文 commit message（一句话，描述做了什么）
4. 用 run_command 执行 `git commit -m "<message>"`。
5. 报告提交结果（commit hash + message）。

## 验证

- 用 run_command 执行 `git log -1 --oneline` 确认最新提交。
- 不要 push，除非用户明确要求。

## 示例

- `use_skill("commit")` — 自动提交所有改动
- `use_skill("commit", "fix: 修复登录页样式")` — 用自定义信息提交

当前工作目录: {{cwd}}
用户附加要求: {{arguments}}
