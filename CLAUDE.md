# CLAUDE.md — Project Rules for mtDNA Tools

## Git Rule

**每改动一项（一个独立的功能点或修复），自动执行以下操作：**

1. `git add -A`
2. `git commit -m "<简要描述改动>"`（中文或英文均可，简洁明了）
3. `git push origin master`

推送前无需征求确认，直接执行。

## Discussion-Only Rule

**当用户明确表示"仅讨论"、"禁止修改代码"、"不要修改"时：**

- 只进行分析、讨论、回答问题和提出方案建议
- **绝对禁止**任何代码修改操作（包括 Edit、Write、删除文件等）
- **绝对禁止**运行可能改变文件系统状态的命令（如 `rm`、`mv`、`npm install` 等）
- 只允许只读操作（Read、Bash 查询、Git 状态查询等）
- 直到用户明确说"可以修改了"、"开始实施"、"动手吧"等指令后，才能恢复修改权限
