# 技术调研报告：用 DeepSeek 操控网易《我的世界》Java 版

> 状态：2026-11 本机实测 + 公开资料整理。文中"本机"指项目作者的 Windows 测试机；
> 网易的策略、客户端版本与协议可能随时变化，落地前请以你机器上的实测为准。

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 网易 Java 版能用官方 ModSDK 吗？ | **不能。** 官方 ModSDK 只面向网易**基岩版**（Python 风格 API + MCStudio），Java 版客户端是 JVM + NeoForge 生态。 |
| 网易 Java 版是什么技术栈？ | 实测为 **NeoForge 21.8.52 + ModLauncher 9.0 + Mojang 官方命名**，MC **1.21.8**，网络协议 **772**。 |
| 怎么让 DeepSeek 操控它？ | **两条通道**：A) mineflayer 机器人以玩家身份进 LAN/联机世界（零侵入，默认）；B) 自写 NeoForge 模组在游戏内开 HTTP（能力更强，可选）。 |
| 协议 772 兼容吗？ | 兼容。`minecraft-data` / `node-minecraft-protocol` / mineflayer 已覆盖 1.21.8（协议 772）；本项目固定 `version: "1.21.8"` 并保留版本回退。 |
| 最大风险是什么？ | 通道 B 的第三方模组在网易客户端上的加载与风控没有官方承诺；通道 A 依赖 LAN 端口且无法执行服务器命令。 |

---

## 1. 问题定义

目标是让 **DeepSeek（运行在 DSH 里，通过 MCP 工具调用）** 观察并操作玩家本地运行的
**网易《我的世界》Java 版**：读位置/背包/附近方块、移动、挖掘、放置、聊天，最好还能执行
`/tp`、`/give` 之类的服务器命令。约束是：不破解客户端、不注入进程、不绕过登录与反作弊、
不把账号密码写进仓库或配置文件。

---

## 2. 网易《我的世界》两条产品线

| 维度 | Java 版（本项目目标） | 基岩版（官方 ModSDK 所在） |
|---|---|---|
| 运行环境 | JVM（本机为 JDK 22 运行时） | C++ 引擎，客户端内嵌脚本运行时 |
| 模组生态 | NeoForge / Fabric / 原版数据包 | 官方 ModSDK（Python 2.7 风格 API） |
| 官方开发工具 | 无中国版专用 ModSDK；走社区模组生态 | MCStudio（`dev.mc.163.com` / `mc.163.com/dev`） |
| 客户端 | `WPFLauncher.exe` 拉起的 Java 客户端实例 | 网易中国版基岩客户端 |
| 本次实测 | MC 1.21.8 + NeoForge 21.8.52，协议 772 | 不在本次范围 |

### 2.1 官方 ModSDK 为什么不能用于 Java 版

1. **ModSDK 的载体是基岩版客户端**。官方文档（[网易我的世界开发者平台](https://mc.163.com/dev/)、
   [MC 开发文档](https://mc.163.com/dev/mcmanual/)）把 ModSDK 描述为运行在网易基岩版客户端内的
   Python 2.7 风格脚本层，通过事件（如 `ServerChatEvent`、`AddEntityServerEvent`）与游戏交互，
   工程由 [MCStudio](https://mc.163.com/dev/) 打包成基岩版附加包/组件。
2. **Java 版没有 Python 解释器这层运行时**。本机 Java 客户端实例里只有 NeoForge 的 `mods/`
   目录与 JVM 进程，没有 ModSDK 运行时目录、没有 Python 引擎，也没有 `serverApi` 之类的注入点。
3. **接口模型不通用**。ModSDK 的 API 名称、事件名、坐标/实体模型都是基岩版概念；
   Java 版的对应物是 NeoForge 事件总线、`MinecraftServer`、Mojang 映射的类。把 ModSDK
   代码"翻译"到 Java 版不是移植，而是重写，且没有官方文档支持。
4. **Java 版官方只提供"中国版启动器 + 联机/租赁服"这一层**，不提供脚本化 ModSDK 接口。

因此本项目选择 **Java 版原生手段**：协议机器人（通道 A）与 NeoForge 模组（通道 B）。

---

## 3. 本机实测证据（2026-11）

### 3.1 实测环境

| 项 | 值 | 证据来源 |
|---|---|---|
| 启动器 | `D:\MC\MC\WPFLauncher.exe` | 文件存在 |
| 实例目录 | `D:\netease_minecraft_neoforge` | 目录存在，含 `logs/`、`mods/`、`config/` |
| MC 版本 | **1.21.8** | `logs/latest.log` 启动段与 `version.json` |
| Mod 加载器 | **NeoForge 21.8.52**（ModLauncher 9.0） | `latest.log` 的 ModLauncher 行 |
| 网易内置模组 | `mods/4687456828685462969@3@0.jar`（`netease_official`） | `mods/` 目录清单 |
| 命名方式 | Mojang 官方命名（非 SRG） | 模组日志中的类名 |
| 网络协议 | **772** | 与 1.21.8 协议表一致 |
| JDK | `D:\MCLDownload\ext\jre-v64-220420\jdk22`，`javac 22` | `javac -version` |

### 3.2 `latest.log` 中的加载器信息（节选示意）

```text
[main/INFO] [ModLauncher/]: ModLauncher 9.0 starting: java version 22 ...
[main/INFO] [net.neoforged.fml/]: NeoForge version 21.8.52
[main/INFO] [net.minecraft.server.MinecraftServer/]: Starting minecraft server version 1.21.8
[main/INFO] [neoforge/]: Found mod file 4687456828685462969@3@0.jar
```

> 说明：以上为便于阅读的节选；实际日志行号与类名可能略有差异。关键结论是
> **NeoForge 21.8.52 + MC 1.21.8 + 网易自有模组共存**，说明实例是标准 NeoForge 加载链。

### 3.3 对实现的意义

- 通道 B 可以写一个**普通 NeoForge 1.21.8 模组**，用 `MinecraftServer#execute` 在服务器
  线程执行动作、用 `HttpServer`（`com.sun.net.httpserver`）监听 `127.0.0.1`，不依赖网易私有 API。
- 通道 A 可以用 mineflayer 连接 **LAN 世界**：网易客户端"对局域网开放"走原版 LAN 协议，
  机器人作为第二个玩家登录，无需修改游戏文件。
- `netease_official` 模组说明网易会随客户端下发自有模组；第三方模组与其共存不保证，
  故通道 B 必须标注为"可选、自担风险"。

---

## 4. 协议 772 与 mineflayer 兼容性

| 组件 | 版本/能力 | 对 1.21.8（协议 772）的支持 |
|---|---|---|
| [minecraft-data](https://github.com/PrismarineJS/minecraft-data) | 协议/方块/物品数据 | 提供 PC 1.21.8 数据（协议 772） |
| [node-minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) | 协议编解码 | 支持 1.21.8 登录与 772 包结构 |
| [mineflayer](https://github.com/PrismarineJS/mineflayer) | 高层机器人 API | 4.x 支持 1.21.8；本项目依赖 `^4.39.0` |

实践要点：

- 配置里**固定** `"version": "1.21.8"`，不要依赖自动探测。LAN 世界的 server list ping
  可能由 NeoForge 改写版本字符串，固定版本更稳。
- 若 `minecraft-data` 对 1.21.8 的某字段缺失，mineflayer 会告警但通常仍能连接；
  出现 `unsupported protocol version` 时，用同协议号的最近版本回落（见 `docs/TROUBLESHOOTING.md`）。
- NeoForge 会在登录阶段注册自定义网络通道（`minecraft:register`）。原版/NeoForge 服务端对
  未安装客户端模组的玩家一般放行；若服务端强制要求某些通道，机器人会在登录后被踢——
  此时改用通道 B。
- 协议 772 覆盖 1.21.6–1.21.8 区间（以 minecraft-data 的映射为准），所以即使网易客户端
  小版本漂移，桥接层也可能继续工作；但**每次客户端大版本更新都应重新实测**。

---

## 5. 现有方案对比

| 方案 | 形态 | 能做什么 | 对网易 Java 版适用性 | 风险/限制 |
|---|---|---|---|---|
| **A. mineflayer 机器人**（本项目通道 A） | Node.js 进程，以玩家身份登录 | 移动/挖掘/放置/背包/实体/聊天 | ✅ 通用，只要目标是 Java 协议服务端/LAN | 无服务器命令权限、看不到全部世界数据、被封禁取决于服务器规则 |
| **B. 自写 NeoForge 模组 + HTTP**（本项目通道 B） | 游戏内 mod，监听 127.0.0.1 | 控制台命令、完整状态、传送/给予/改方块 | ⚠️ 实例是 NeoForge 1.21.8，理论可加载；网易风控无承诺 | 第三方模组可能被拦截/导致账号风险；需重启游戏 |
| **C. AIM 一类"世界代理"模组 + MCP**（[mcmod.cn/class/32086](https://mcmod.cn/class/32086)） | 社区 NeoForge 模组对外提供 MCP/世界代理 | 面向 AI 的方块世界读写、MCP 工具 | ⚠️ 面向通用 Java 服，未验证网易客户端；依赖其发布节奏 | 引入第三方二进制；与网易内置模组兼容性未知 |
| **D. MCNeteaseDevs/modsdk_mcp_server**（[GitHub](https://github.com/MCNeteaseDevs/modsdk_mcp_server)） | MCP Server | **辅助编写基岩版 ModSDK（Python）代码**，提供文档/API 检索 | ❌ 不是游戏操控；面向基岩版开发 | 需要 ModSDK 工程，无法驱动 Java 版运行时 |
| **E. 官方 ModSDK（MCStudio）** | 基岩版脚本 | 基岩版服务端逻辑 | ❌ 仅基岩版 | 与 Java 版无关 |
| **F. 内存注入/按键模拟** | 外挂式 | 理论上什么都能做 | ❌ 违反 EULA/反作弊，明确不做 | 封号、法律与安全风险 |

**为什么不是 C 或 D？**

- C 是别人的模组二进制，能力与 MCP 接口由对方决定，且没有针对网易客户端的验证；
  本项目把同样思路**自己实现**（通道 B），代码可控、可审计、接口与通道 A 统一。
- D 解决的是"用 AI 写基岩版 ModSDK 代码"，不是"AI 玩 Java 版"；与本项目目标不同。

---

## 6. 技术选型：为什么是双通道

```text
DeepSeek / DSH ──MCP stdio──> packages/bridge ──┬── mineflayer ──> LAN 世界（通道 A，默认）
                                                └── HTTP 127.0.0.1 ──> NeoForge 模组（通道 B，可选）
```

- **统一语义、两套实现**：MCP 工具名与参数完全一致（见 `docs/ARCHITECTURE.md` 第 4 节），
  用户切换 `mode` 即可，不用改提示词。
- **默认零侵入**：通道 A 不改游戏文件、不注入、不需要重启游戏，适合"先跑起来"。
- **可选增强**：需要 `/tp`、`/give`、读取完整世界状态时，装通道 B 模组。
- **故障可降级**：模组加载失败或被风控，退回通道 A 仍可用；通道 A 协议不兼容，通道 B 仍可用。

### 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 网易客户端拒绝加载第三方 NeoForge 模组 | 通道 B 不可用 | 默认通道 A；模组仅本机、可一键卸载 |
| 网易账号因第三方模组被风控/封禁 | 账号损失 | 文档显著警告；建议小号/测试号；不自动安装模组 |
| 协议 772 在客户端更新后变化 | 通道 A 连接失败 | 升级 mineflayer/minecraft-data；或改用通道 B |
| LAN 端口随机且不持久 | 每次开世界需重新探测 | `scripts/detect-lan.ps1` 自动探测 |
| 机器人能力被误用（拆家、PVP） | 破坏存档/服务器规则 | `policy` 权限闸门、`--dry-run`、世界备份 |
| DeepSeek API 费用/密钥泄露 | 费用与安全 | 仅环境变量注入，日志不打印密钥 |

---

## 7. 未决问题

1. 网易 Java 版是否会主动扫描/拦截 `mods/` 下的非官方模组，目前无公开结论，只能按"可能"处理。
2. 1.21.8 之后的新协议需要重新对照 minecraft-data 的映射与 mineflayer 支持情况。
3. LAN 世界在玩家退出后端口立即消失；自动化流程需要"先玩家开世界、机器人后连接"的时序约束。
4. mineflayer 的寻路在复杂地形（水、梯子、门）下成功率有限，长距离移动建议分段。

---

## 8. 参考资料

- 网易我的世界开发者平台：<https://mc.163.com/dev/>
- 网易 MC 开发文档（ModSDK 仅基岩版）：<https://mc.163.com/dev/mcmanual/>
- NeoForge 官网：<https://neoforged.net/>
- ModLauncher：<https://github.com/MinecraftForge/ModLauncher>
- mineflayer：<https://github.com/PrismarineJS/mineflayer>
- minecraft-data：<https://github.com/PrismarineJS/minecraft-data>
- node-minecraft-protocol：<https://github.com/PrismarineJS/node-minecraft-protocol>
- Minecraft 协议版本表：<https://minecraft.wiki/w/Java_Edition_protocol/Packets>
- AIM 世界代理模组（mcmod）：<https://mcmod.cn/class/32086>
- MCNeteaseDevs/modsdk_mcp_server：<https://github.com/MCNeteaseDevs/modsdk_mcp_server>
- MCP 规范：<https://modelcontextprotocol.io/>
