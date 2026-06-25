---
name: debug
version: 1.0.0
author: Token炼金师
description: 调试 bug 的标准流程——复现→定位→修复→验证
tags: [调试, bug]
args:
  - name: issue
    description: 问题描述或报错信息
    required: true
---

## 指令

按标准调试流程解决 bug：先复现，再定位根因，再修，再验。

## 步骤

1. 用 todo 工具创建调试清单：复现、定位、修复、验证。
2. **复现**：用 run_command 运行用户提供的复现命令；若未提供，尝试根据报错信息推断。
3. **定位**：
   - 读取报错涉及的文件（read_file）
   - 用 grep 搜索相关错误信息/关键函数
   - 确定出错的具体位置和原因
3. **修复**：用 edit_file 做最小修改，只改出错处，不改无关代码。
4. **验证**：用 run_command 重新运行复现命令，确认不再报错。
5. 每步完成后 todo update 状态。

## 验证

- 复现命令运行后无报错。
- 相关测试（如有）通过。

## 示例

- `use_skill("debug", "运行 pnpm test 时 test_sort 失败")`
- `use_skill("debug", "登录页面点提交后 500 错误")`

问题: {{arguments}}
工作目录: {{cwd}}
