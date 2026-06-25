---
name: new-feature
version: 1.0.0
author: Token炼金师
description: 开发新功能的标准流程——先列 todo、再实现、最后验证
tags: [开发, 功能]
args:
  - name: feature
    description: 功能描述
    required: true
---

## 指令

按标准流程开发用户描述的新功能：拆任务 → 观察现有代码 → 实现 → 验证。

## 步骤

1. 用 todo 工具把任务拆成 3-6 个子步骤（先观察、再设计、再实现、再验证）。
2. 第一步：用 list_dir / read_file / grep 摸清相关现有代码结构。
3. 第二步：用 edit_file 或 edit_files 做最小改动实现功能，必要时 write_file 创建新文件。
4. 第三步：用 run_command 跑测试或编译验证；失败就修，最多重试 3 次。
5. 每完成一步用 todo update 把状态改为 done。
6. 全部完成后简述改了什么、在哪些文件。

## 验证

- 相关测试通过（或编译无错）。
- 核心功能行为符合预期。

## 示例

- `use_skill("new-feature", "添加导出 CSV 功能")`
- `use_skill("new-feature", "用户注册时发欢迎邮件")`

功能描述: {{arguments}}
工作目录: {{cwd}}
