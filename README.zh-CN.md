# 私有记忆系统安装器｜Windows

把已有的私有 Obsidian 笔记仓库连接到本机，通过 Git 同步，并安装供 Codex 使用的本地记忆工具。这个公开仓库存放安装程序与工具代码，不存放个人笔记或账号凭据。

## 适合什么时候用

- 在新的 Windows 电脑上接入自己的私有记忆库。
- 重新安装本地记忆工具，或检查现有配置。
- 将笔记内容与可公开的安装程序分开维护。

这是安装工具，不是笔记内容包。默认需要使用有权访问目标私有仓库的 GitHub 账号；安装器不会替你创建该私有仓库。

## 安装前准备

- Windows 与 PowerShell。
- 已有目标 Obsidian Vault，或能访问用于同步的私有 GitHub 仓库。
- 如果要在 Codex 中调用记忆工具，准备相应的 Codex 环境。

脚本会检查 Git、Node.js 和 GitHub CLI，缺失时可能下载或安装依赖；会写入当前用户的工具目录、配置和 PATH。启动之前可阅读 [install.ps1](install.ps1)。

## 固定版本安装

当前仓库已核对的最新标签为 `v0.1.1`。沿用原版 README 的固定版本入口，在 PowerShell 执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://raw.githubusercontent.com/Lujiuqin/compound-memory-installer/v0.1.1/install.ps1' | iex"
```

脚本会检查环境、按需进行 GitHub 登录、连接已有的私有仓库、安装本地运行工具，并执行健康检查。默认目标是已登录 GitHub 账号下名为 `obsidian-memory-system` 的仓库。

安装完成后按照终端提示重新启动 Codex，并在新会话中使用。若自动注册没有成功，按脚本输出检查本地插件状态。

## 自定义目录或仓库

先下载或克隆本仓库，在其目录中执行：

```powershell
.\install.ps1 -VaultRepository '你的GitHub账号/你的私有仓库' -VaultPath 'D:\Obsidian\我的记忆库'
```

上面的账号、仓库与路径是需要替换的示例。指定的现有非空目录必须对应预期仓库，脚本会检查，避免直接覆盖无关目录。

只接入已有的本地笔记目录时，可以使用：

```powershell
.\install.ps1 -LocalOnly -VaultPath 'D:\Obsidian\我的记忆库'
```

`LocalOnly` 要求目录已经存在，并跳过 GitHub 登录和克隆；不表示所有运行依赖都已经安装，也不保证安装过程完全离线。

## 日常命令

| 命令 | 用途 |
|---|---|
| `memoryctl status` | 查看本地记忆系统状态 |
| `memoryctl doctor` | 执行环境与配置健康检查 |
| `memoryctl sync` | 调用同步流程；运行前确认本地改动和冲突情况 |
| `memoryctl review` | 调用复盘流程 |

具体行为以当前安装版本为准；遇到失败，保留输出供排查，不通过覆盖笔记来解决冲突。

## 文件导航

| 路径 | 内容 |
|---|---|
| [install.ps1](install.ps1) | Windows 安装与配置入口 |
| [scripts/memoryctl.ps1](scripts/memoryctl.ps1) | 日常管理命令 |
| [plugins/compound-memory/mcp/server.mjs](plugins/compound-memory/mcp/server.mjs) | 本地记忆工具实现 |
| [plugins/compound-memory/skills/memory-system/SKILL.md](plugins/compound-memory/skills/memory-system/SKILL.md) | AI 使用记忆系统的工作说明 |

## 本轮维护记录

2026-10-27：增加中文导航和操作说明，核对脚本参数与 `v0.1.1` 标签。没有修改安装程序、升级运行时、重新安装本机系统或执行笔记同步，也没有改动旧发布标签。

[English README](README.md) · [返回 GitHub 仓库导航](https://github.com/Lujiuqin/creator-repository-collection/blob/main/GITHUB_NAVIGATION.md)
