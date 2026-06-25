---
name: refactor
version: 1.0.0
author: Token炼金师
description: 重构代码的标准流程——先补测试→重构→确认测试通过
tags: [重构, 代码质量]
args:
  - name: target
    description: 要重构的目标（文件/函数/模块）
    required: true
---

## 指令

安全重构代码：先确认现有测试，再重构，再验证行为不变。

## 步骤

1. 用 todo 创建清单：理解现状、补测试（如无）、重构、验证。
2. **理解现状**：用 read_file 读取目标代码，grep 找所有引用点。
3. **补测试**（若现有测试不足）：用 write_file 写测试，run_command 跑一遍确认通过。
4. **重构**：用 edit_file/edit_files 做重构，保持接口不变。
5. **验证**：run_command 跑全部测试，确认全部通过；失败则回退重做。
6. 每步完成后 todo update 状态。

## 验证

- 重构前后测试结果一致（全部通过）。
- 无新增 lint 错误（如有 linter）。

## 示例

- `use_skill("refactor", "重构 utils.js 中的 sort 函数")`
- `use_skill("refactor", "将 UserController 拆分为 Service + Handler")`

重构目标: {{arguments}}
工作目录: {{cwd}}
