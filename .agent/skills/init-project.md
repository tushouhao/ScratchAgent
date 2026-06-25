---
name: init-project
version: 1.0.0
author: Token炼金师
description: 初始化新项目——选技术栈、建目录结构、配 lint/test/git
tags: [项目, 初始化]
args:
  - name: tech
    description: 技术栈描述（如 node/python/go/rust）
    required: true
---

## 指令

初始化一个新项目：根据技术栈创建标准目录结构、配置文件、git 仓库。

## 步骤

1. 用 todo 创建清单：建目录、写配置、初始化 git、创建 README。
2. **建目录**：根据技术栈创建标准结构：
   - Node: src/ test/ + package.json + .gitignore
   - Python: src/ tests/ + pyproject.toml + .gitignore
   - Go: cmd/ internal/ + go.mod + .gitignore
   - Rust: src/ + Cargo.toml + .gitignore
3. **写配置**：write_file 创建配置文件、.gitignore、lint 配置（如适用）。
4. **初始化 git**：run_command `git init` + `git add -A` + `git commit`。
5. **写 README**：write_file 创建 README.md，含项目名、用法、开发指引。
6. 每步完成后 todo update 状态。

## 验证

- 项目目录结构完整。
- git 仓库已初始化且有首次提交。
- 配置文件语法正确（run_command 跑 lint/validate）。

## 示例

- `use_skill("init-project", "node")` — 初始化 Node.js 项目
- `use_skill("init-project", "python")` — 初始化 Python 项目

技术栈: {{arguments}}
工作目录: {{cwd}}
