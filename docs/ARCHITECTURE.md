# 架构与接口契约（唯一真源）

> 本文件是 `dsh-netease-mc` 的内部契约。所有实现（bridge / mod / 文档 / 安装脚本）必须与本文一致。
> 变更接口时先改本文件，再改两侧代码。

## 1. 目标

让 **DeepSeek（通过 DSH 的 MCP 工具层）** 能够观察并操控 **网易《我的世界》Java 版**。

实测环境（2026-11，本机）：

| 项 | 值 |
|---|---|
| 网易 Java 版客户端 | `D:\MC\MC\WPFLauncher.exe`（我的世界启动器） |
| 游戏实例目录 | `D:\netease_minecraft_neoforge` |
| MC 版本 | **1.21.8**（2025-07-17 构建） |
| Mod 加载器 | **NeoForge 21.8.52**（`ModLauncher 9.0`，运行时为 Mojang 官方命名） |
| 内置网易模组 | `mods/4687456828685462969@3@0.jar`（`netease_official`） |
| 网络协议 | **772**（1.21.8），与 `minecraft-data` / mineflayer 兼容 |
| 运行时 JDK | `D:\MCLDownload\ext\jre-v64-220420\jdk22`（`javac 22` 可用） |

平台差异要点（调研结论）：

- 网易**基岩版**才有官方 ModSDK（Python 2.7 风格 API + `MCStudio`）。本机的网易 **Java 版**并不是 ModSDK 运行时，而是 **NeoForge 21.8.52 + 官方命名**，因此官方 ModSDK 方案不适用。
- 网易 Java 版对第三方 NeoForge 模组的兼容性没有公开承诺。因此本项目提供 **两条通道**，默认走零侵入通道。

## 2. 双通道设计

```
                    ┌──────────────────────────────────────────────┐
                    │ DSH (DeepSeek Harness)                       │
                    │   dsh-mcp-client → mcp__neteasemc__* 工具    │
                    └───────────────────────┬──────────────────────┘
                                            │ MCP (stdio, JSON-RPC 2.0)
                    ┌───────────────────────▼──────────────────────┐
                    │ packages/bridge  (Node.js, 零运行时依赖)      │
                    │  index.js    MCP 服务器（工具注册/调用）      │
                    │  game/bot.js   通道 A：mineflayer 玩家机器人  │
                    │  game/mod.js   通道 B：游戏内模组 HTTP     │
                    │  agent/deepseek.js  自主循环（DeepSeek API）  │
                    │  policy.js     权限闸门（读/写/命令/聊天）    │
                    └───────┬───────────────────────────┬──────────┘
                            │ 通道 A                     │ 通道 B
                            │ MC 协议 772                │ HTTP 127.0.0.1
                            │ (联机/LAN 世界)            │ (NeoForge 模组)
                    ┌───────▼──────────┐        ┌───────▼──────────┐
                    │ 网易 Java 版      │        │ packages/mod      │
                    │ 对局域网开放的世界 │        │ neoForge 模组     │
                    └──────────────────┘        └──────────────────┘
```

### 通道 A — `bot`（默认，零侵入）

- 使用 `mineflayer` 以**另一个玩家**身份登录目标世界（联机服务器或网易客户端「对局域网开放」出的 LAN 端口）。
- 不修改游戏文件、不注入进程、不碰网易反作弊 → **不触发封号风险**，也无需重启游戏。
- 能力：移动/寻路、挖掘、放置、攻击、使用、背包、方块查询、实体查询、聊天。
- 限制：无法执行服务器命令（控制台权限）、无法读取世界全部数据、无法截图。

### 通道 B — `mod`（可选，能力更强）

- 在游戏实例 `mods/` 放入 `netease-mc-link-<ver>.jar`，模组以 **server 端权限**提供 HTTP 接口。
- 能力：完整玩家/世界状态、任意 `/命令`（含 `/tp /give /setblock /summon /time /weather /effect`）、方块/实体查询、聊天、传送、给予物品。
- 限制：需要重启游戏；第三方模组在网易版上的加载/风控未获官方保证，**使用前请自行评估**（见 `docs/SECURITY.md`）。
- 模组只监听 `127.0.0.1`，强制 token 鉴权，默认关闭写操作以外的危险开关可配置。

两条通道向 bridge 暴露**同一套语义**，bridge 通过 `mode` 选择实现，MCP 工具名完全一致。

## 3. Bridge 配置

配置文件查找顺序：`--config <path>` → 环境变量 `DSH_MC_CONFIG` → `./dsh-mc.config.json` → `~/.dsh-mc/config.json`。

```json
{
  "mode": "bot",
  "bot": {
    "host": "127.0.0.1",
    "port": 25565,
    "username": "DeepSeek",
    "version": "1.21.8",
    "auth": "offline",
    "connectTimeoutMs": 20000
  },
  "mod": {
    "url": "http://127.0.0.1:38210",
    "token": "",
    "timeoutMs": 5000
  },
  "policy": {
    "allowRead": true,
    "allowMove": true,
    "allowWorldWrite": true,
    "allowCommands": true,
    "allowChat": true,
    "allowAttack": true
  },
  "agent": {
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "maxSteps": 40,
    "temperature": 0.3
  },
  "log": { "level": "info", "file": "" }
}
```

规则：

- 未知字段忽略；缺失字段用默认值。
- 密钥**只能**来自环境变量（`DEEPSEEK_API_KEY` / `DSH_MC_TOKEN`），配置文件不得包含明文密钥，仓库中不得提交真实配置。
- `mode=bot` 时 `bot.port` 必填；`mode=mod` 时 `mod.token` 必填。
- 权限闸门在工具执行入口统一检查，被禁止的操作返回结构化错误，不做静默降级。

## 4. MCP 工具契约

服务器名（namespace）：`neteasemc`。工具对外名称 `mcp__neteasemc__<tool>`。

每个工具返回 **JSON 文本内容**（`content:[{type:"text",text:"<json>"}]`），并在 `structuredContent` 中放同一对象。失败时 `isError:true`，文本为 `{"ok":false,"error":{"code":"...","message":"..."}}`。

| 工具 | 参数（JSON Schema 摘要） | 说明 | bot | mod |
|---|---|---|---|---|
| `mc_status` | `{}` | 连接状态、服务器/模组版本、模式、权限 | ✅ | ✅ |
| `mc_state` | `{}` | 本人位置/生命/饥饿/维度/等级/游戏模式/世界时间天气 | ✅ | ✅ |
| `mc_players` | `{}` | 在线玩家列表（名字、位置） | ✅ | ✅ |
| `mc_inventory` | `{ "includeEmpty": boolean? }` | 背包物品槽位 | ✅ | ✅ |
| `mc_nearby_entities` | `{ "radius": number?, "limit": number?, "type": string? }` | 附近实体 | ✅ | ✅ |
| `mc_nearby_blocks` | `{ "radius": number?, "block": string?, "limit": number? }` | 附近指定方块坐标 | ✅ | ✅ |
| `mc_block` | `{ "x": number, "y": number, "z": number }` | 单方块信息 | ✅ | ✅ |
| `mc_move` | `{ "x"?, "y"?, "z"? , "player"? , "lookAt"? , "stop"? }` | 走到坐标/跟随玩家/看向/停止 | ✅ | ✅ |
| `mc_mine` | `{ "x"?, "y"?, "z"?, "block"?, "count"? }` | 挖掘指定坐标或最近的目标方块 | ✅ | ✅ |
| `mc_place` | `{ "x": number, "y": number, "z": number, "item"?: string }` | 放置方块 | ✅ | ✅ |
| `mc_use` | `{ "item"?: string, "offhand"?: boolean }` | 使用/装备/吃 | ✅ | ✅ |
| `mc_attack` | `{ "entityId"?: number, "nearest"?: boolean }` | 攻击实体 | ✅ | ✅ |
| `mc_chat` | `{ "message"?: string, "read"?: boolean, "limit"?: number }` | 发言 / 读取最近聊天 | ✅ | ✅ |
| `mc_command` | `{ "command": string }` | 执行服务器命令（无斜杠） | ❌（明确报错） | ✅ |

> `mc_command` 在 `bot` 模式下必须返回 `code:"unsupported_in_bot_mode"` 并提示可改用 `mc_chat` 或在输入框手动执行，不允许伪造成功。

### 工具行为细节（必须实现）

- 所有坐标为 `double`，y 轴为 Minecraft 坐标；`mc_move` 使用 mineflayer `pathfinder`（`goto`）并带超时（默认 30s，可由参数覆盖）。
- `mc_mine` 的 `block` 参数接受 `minecraft:oak_log` 或 `oak_log`，按 `block.name` 匹配最近的方块。
- `mc_inventory` 返回 `{slot, name, displayName, count, durability?}`。
- `mc_nearby_entities` 返回 `{id, name, type, x, y, z, distance}`，自身除外。
- 读类工具超时 10s，写类工具 35s，`mc_command` 15s。
- 每个工具调用记录 `{ts, tool, args, ok, ms}` 到日志（不记录聊天内容之外的敏感信息）。

### 通道 B 的 v1 兼容降级（实现已落地）

模组 v1 的 `POST /action` 只实现 `tp|give|setblock|summon|time|weather|gamemode|effect|kill`，
因此 bridge 对 `mc_move`/`mc_mine`/`mc_place`/`mc_attack` 采用「先试 `/action`，遇
`unsupported_action`/`not_found` 再走 `/command`」的降级策略（见 `src/game/mod.js#actionWithFallback`）：

| 工具 | 降级命令 |
|---|---|
| `mc_move`（坐标/玩家） | `tp <player> <x> <y> <z>` / `tp <player> <target>` |
| `mc_move`（lookAt） | `tp <player> ~ ~ ~ <yaw> <pitch>` |
| `mc_mine` | `setblock <x> <y> <z> air destroy` |
| `mc_place` | `setblock <x> <y> <z> <item>` |
| `mc_attack` | `damage @e[type=!player,limit=1,sort=nearest] 5` |
| `mc_use` | 无等价命令 → 返回 `unsupported_in_mod_mode`（明确失败，不伪造成功） |
| `mc_chat`（读） | 模组 v1 不记录聊天历史 → 返回空列表 + `note` 字段 |


## 5. 游戏内模组 HTTP 契约（通道 B）

- 监听 `127.0.0.1:38210`（可配置，仅本机）。
- 鉴权：`Authorization: Bearer <token>` 或 `X-MC-Token: <token>`；`GET /health` 免鉴权但仅返回 `{ok,mod,mc,port}`。
- Token 首次启动生成到 `<gameDir>/config/netease_mc_link.json`，同时打印到日志。
- 所有响应 `application/json; charset=utf-8`，`{ok:true,...}` / `{ok:false,error:{code,message}}`，HTTP 4xx/5xx 对应错误。
- 动作在服务器线程执行（`MinecraftServer#execute`），不得阻塞 tick。

| 方法/路径 | 说明 |
|---|---|
| `GET /health` | 存活探测 |
| `GET /state` | `{player:{name,uuid,x,y,z,yaw,pitch,health,food,gamemode,dimension,level,exp},world:{time,day,weather,difficulty},players:[{name,x,y,z,health}]}` |
| `GET /inventory` | 背包槽位 |
| `GET /block?x&y&z` | `{id, properties, solid, blockEntity?}` |
| `GET /blocks?radius&block&limit` | 附近方块列表，按距离升序 |
| `GET /entities?radius&type&limit` | 附近实体 |
| `POST /command` `{"command":"time set day"}` | 以控制台权限执行，返回 `{ok,output:[...]}` |
| `POST /chat` `{"message":"hi"}` | 以玩家身份发言 |
| `POST /action` `{"type":"tp|give|setblock|summon|time|weather|gamemode|effect|kill","...":...}` | 高层动作（内部转命令，带参数校验） |

## 6. 自主代理循环（`dsh-mc agent`）

- 输入：自然语言目标；输出：逐步决策日志 + 最终报告。
- 使用 DeepSeek Chat Completions 的 function calling（`tools` 参数），工具集 = 第 4 节工具去掉 `mc_agent`。
- 每一步：把 `mc_state` 摘要 + 上一步结果喂给模型 → 执行工具调用 → 记录 → 直到模型不再调用工具或达到 `maxSteps`。
- 安全：`policy` 闸门同样生效；`--dry-run` 只打印计划不执行；Ctrl+C 安全退出并断开 bot。
- 该循环在 bridge 内部独立实现，与 DSH 自身的 DeepSeek 推理互不干扰（避免嵌套调用）。

## 7. 安装与 DSH 注册

`scripts/install.ps1` 做四件事：

1. 检测游戏实例目录（默认 `D:\netease_minecraft_neoforge`，可用 `-GameDir` 覆盖）。
2. `npm install --omit=dev` 安装 bridge 依赖（mineflayer）。
3. 生成 `%USERPROFILE%\.dsh-mc\config.json` 模板（不覆盖已有文件）。
4. 在 DSH profile 的 `cordis.patch.yml` 追加/更新 `mcp-netease-mc` 条目（先备份），stdio 启动 bridge，env 注入 `DSH_MC_CONFIG`。

可选 `-InstallMod`：把构建好的模组 jar 复制到 `<gameDir>/mods/`（先备份目录清单，可 `-RemoveMod` 卸载）。

## 8. 非目标 / 明确不做

- 不破解、不注入网易进程内存，不绕过登录与反作弊。
- 不保存、不上传用户账号密码（GitHub 凭据、网易账号一律不落盘到仓库）。
- 不做截图/视觉控制（v1）；不做多 bot 舰队；不做网易基岩版 ModSDK（本项目面向 Java 版）。
