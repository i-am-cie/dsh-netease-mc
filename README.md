# dsh-netease-mc

> 让 **DeepSeek** 通过 **DSH（DeepSeek Harness）的 MCP 工具层**，观察并操控**网易《我的世界》Java 版**。
>
> 一个零侵入的桥接层：外部用 MCP，内部有两条通道——**mineflayer 机器人**（默认）或**游戏内 NeoForge 模组**（可选）。

Platform: Windows · Node.js ≥20 · License: MIT


---

## 这是什么

`dsh-netease-mc` 在 **DSH** 里注册一个名为 `neteasemc` 的 MCP server，向 DeepSeek 暴露
`mcp__neteasemc__mc_*` 工具：读取位置/背包/附近方块、移动、挖掘、放置、攻击、聊天；
装了可选模组后还能执行 `/tp`、`/give`、`/setblock` 等服务器命令。

**它不是什么**：不是外挂，不注入网易进程内存，不绕过登录/反作弊，不自动登录账号，
也不做截图视觉控制（v1）。详见 [docs/SECURITY.md](docs/SECURITY.md)。

---

## 实测环境

2026-11 在本机（Windows）实测通过的环境如下；版本不一致时请先读
[docs/RESEARCH.md](docs/RESEARCH.md) 与 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

| 项 | 值 |
|---|---|
| 操作系统 | Windows 10/11 x64 |
| 网易 Java 版客户端 | `D:\MC\MC\WPFLauncher.exe`（我的世界启动器） |
| 游戏实例目录 | `D:\netease_minecraft_neoforge` |
| Minecraft | **1.21.8** |
| Mod 加载器 | **NeoForge 21.8.52**（ModLauncher 9.0，Mojang 官方命名） |
| 内置网易模组 | `mods/4687456828685462969@3@0.jar`（`netease_official`） |
| 网络协议 | **772**，与 `minecraft-data` / mineflayer 兼容 |
| 运行时 JDK | `D:\MCLDownload\ext\jre-v64-220420\jdk22`（`javac 22`） |
| Node.js | 20+（实测 v24.16.0） |
| DSH | 桌面版，profile `desktop` |

---

## 两条通道

| | 通道 A：`bot`（默认，零侵入） | 通道 B：`mod`（可选，能力更强） |
|---|---|---|
| 原理 | mineflayer 以**另一个玩家**身份登入 LAN/联机世界 | 自编译 NeoForge 模组在游戏内开 `127.0.0.1` HTTP |
| 是否改游戏 | ❌ 不改 | ✅ 往 `mods/` 放 jar，需重启游戏 |
| 服务器命令 | ❌ 无权限 | ✅ 控制台权限（`/tp` `/give` `/setblock` …） |
| 世界数据 | 附近方块/实体（受视野与距离限制） | 完整玩家/世界状态 |
| 截图 | ❌ | ❌（v1） |
| 封号风险 | 低（普通玩家行为） | ⚠️ 第三方模组，网易无官方承诺，需自行评估 |
| 适合 | 快速开始、单机/LAN、朋友服 | 自己完全掌控的实例、需要命令的场景 |

两条通道对 MCP 暴露**同一套工具名与参数**，切换只需改配置里的 `mode`。
架构细节与接口契约见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**（唯一真源）。

---

## 5 分钟快速开始

### 0. 前置条件

- Windows 10/11；**Node.js 20+**（`node --version`）；
- 已安装并能启动网易《我的世界》Java 版（1.21.8 实测）；
- 已安装 DSH 桌面版（MCP 客户端由其提供）；
- 可选：JDK 21/22（只有构建通道 B 模组时才需要）。

### 1. 获取代码并安装

```powershell
git clone https://github.com/i-am-cie/dsh-netease-mc.git
cd dsh-netease-mc

# 安装 bridge 依赖 + 生成配置模板 + 注册到 DSH（幂等，可重复执行）
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -GameDir "D:\netease_minecraft_neoforge"
```

> 仓库地址以实际发布为准；也可直接下载 ZIP 解压后进入目录。

`install.ps1` 会：

1. 检查 Node.js（≥20）与 JDK（可选）；
2. 在 `packages\bridge` 执行 `npm install --omit=dev`；
3. 生成 `%USERPROFILE%\.dsh-mc\config.json`（**已存在则不覆盖**）；
4. 备份并在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 追加/更新
   `mcp-netease-mc` 条目，stdio 启动 bridge，注入 `DSH_MC_CONFIG`。

先看看它会做什么（不写盘）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun
```

### 2. 准备游戏入口（二选一）

**通道 A（推荐先跑这个）—— 对局域网开放：**

1. 启动网易我的世界 Java 版，进入一个世界；
2. 按 `Esc` → **对局域网开放** → 确认；
3. 探测随机 LAN 端口并写入配置：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\detect-lan.ps1
```

把输出里的端口填进 `%USERPROFILE%\.dsh-mc\config.json` 的 `bot.port`，例如：

```json
{
  "mode": "bot",
  "bot": { "host": "127.0.0.1", "port": 54321, "username": "DeepSeek", "version": "1.21.8", "auth": "offline" }
}
```

**通道 B（可选）—— 安装游戏内模组：**

```powershell
# 1) 构建模组（需要 JDK 21/22；脚本会从本地 libraries 拼 classpath）
powershell -ExecutionPolicy Bypass -File packages\mod\build.ps1 -GameDir "D:\netease_minecraft_neoforge"

# 2) 关闭游戏，把 jar 放进实例的 mods/ 目录（脚本会先记录 mods 清单）：
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -InstallMod

# 3) 重新启动游戏，读取 <GameDir>\config\netease_mc_link.json 里的 token。
#    bridge 只从环境变量读取 token（配置文件里的 mod.token 会被忽略并告警）：
#    setx DSH_MC_TOKEN "<token>"   # 然后重开终端/DSH
#    并让 config.json 保持 "mode": "mod"
```

> 模组只监听 `127.0.0.1`，强制 token 鉴权，未在真机加载验证前请自行评估风险
> （见 [docs/SECURITY.md](docs/SECURITY.md)）。

### 3. 重启 DSH，验证工具

重启 DSH（或重新加载 profile），然后让它调用：

```text
调用 mcp__neteasemc__mc_status，告诉我连接状态和模式。
```

看到类似输出即成功：

```json
{ "ok": true, "mode": "bot", "connected": true, "server": "1.21.8", "protocol": 772 }
```

也可以用内置诊断（不经过 DSH）：

```powershell
cd packages\bridge
node src\index.js doctor
node src\index.js probe     # 探测 LAN 端口
```

### 4. 试一句自然语言

```text
用 mc_state 看看我在哪，然后用 mc_nearby_blocks 找半径 16 格内的橡木原木，
告诉我最近的 3 个坐标。
```

---

## MCP 工具清单

工具对外名称统一为 `mcp__neteasemc__<tool>`，服务器 namespace 为 `neteasemc`。
所有工具返回 JSON 文本（`content:[{type:"text",text:"<json>"}]`），失败时 `isError:true`。

| 工具 | 参数（摘要） | 说明 | bot | mod |
|---|---|---|---|---|
| `mc_status` | `{}` | 连接状态、服务器/模组版本、模式、权限 | ✅ | ✅ |
| `mc_state` | `{}` | 位置/生命/饥饿/维度/等级/游戏模式/时间/天气 | ✅ | ✅ |
| `mc_players` | `{}` | 在线玩家（名字、位置） | ✅ | ✅ |
| `mc_inventory` | `{includeEmpty?: boolean}` | 背包物品槽位 | ✅ | ✅ |
| `mc_nearby_entities` | `{radius?, limit?, type?}` | 附近实体 | ✅ | ✅ |
| `mc_nearby_blocks` | `{radius?, block?, limit?}` | 附近指定方块坐标 | ✅ | ✅ |
| `mc_block` | `{x, y, z}` | 单方块信息 | ✅ | ✅ |
| `mc_move` | `{x?, y?, z?, player?, lookAt?, stop?}` | 走到坐标/跟随/看向/停止 | ✅ | ✅ |
| `mc_mine` | `{x?, y?, z?, block?, count?}` | 挖掘指定坐标或最近的目标方块 | ✅ | ✅ |
| `mc_place` | `{x, y, z, item?}` | 放置方块 | ✅ | ✅ |
| `mc_use` | `{item?, offhand?}` | 使用/装备/吃 | ✅ | ✅ |
| `mc_attack` | `{entityId?, nearest?}` | 攻击实体 | ✅ | ✅ |
| `mc_chat` | `{message?, read?, limit?}` | 发言 / 读取最近聊天 | ✅ | ✅ |
| `mc_command` | `{command}` | 执行服务器命令（无斜杠） | ❌ `unsupported_in_bot_mode` | ✅ |

补充约定（完整契约见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 第 4 节）：

- 坐标均为 `double`；读类工具超时 10s，写类 35s，`mc_command` 15s；
- `mc_mine` 的 `block` 接受 `minecraft:oak_log` 或 `oak_log`；
- 权限闸门由 `config.policy` 控制，被拒绝时返回 `{ok:false,error:{code:"policy_denied",...}}`，
  **不会静默降级**；
- `mc_command` 在 bot 模式必须明确报错，不允许伪造成功。

---

## 自主代理（内置 agent 循环）

bridge 自带一个基于 DeepSeek Chat Completions（function calling）的自主循环，可直接在终端用：

```powershell
cd packages\bridge

# 先 dry-run 看计划，不执行任何世界操作
node src\index.js agent --goal "在我面前用橡木木板搭一个 3x3 的小屋" --max-steps 20 --dry-run

# 确认后去掉 --dry-run
node src\index.js agent --goal "在我面前用橡木木板搭一个 3x3 的小屋" --max-steps 20
```

- 需要环境变量 `DEEPSEEK_API_KEY`（只从环境变量读取，**不要写进配置文件**）；
- 与 DSH 内的 MCP 调用互不干扰：agent 在 bridge 进程内独立运行，避免嵌套调用；
- 安全开关：`policy` 闸门同样生效；`--dry-run` 只打印计划；`Ctrl+C` 安全退出并断开 bot；
- 也可以不用内置 agent——直接在 DSH 对话里让 DeepSeek 调 MCP 工具即可（不需要 API key）。

---

## 实战示例：从零建一座小木屋

下面是**在 DSH 对话里**用自然语言指挥 DeepSeek 的完整过程（工具调用与输出为便于阅读的伪输出，
真实字段以实际返回为准）。场景：网易 Java 版 1.21.8，单人世界，**通道 B（`mode: "mod"`）**。

> **关于"合成"**：v1 的 MCP 工具契约（[ARCHITECTURE 第 4 节](docs/ARCHITECTURE.md#4-mcp-工具契约)）
> 只有采集/放置/使用，**没有独立合成工具**。示例中的"合成"用 mod 通道的 `mc_command`
> `give` 取得成品木板来代替；若走 bot 通道，bot 没有命令权限（`mc_command` 会返回
> `unsupported_in_bot_mode`），这一步需要玩家手动合成，其余步骤不变。后续版本计划补 `mc_craft`。

> **用户**：帮我在出生点附近建一座小木屋：先砍几棵树，用木板搭一个 5×5、高 3 格的小屋，留个门。
>
> **DeepSeek**：好，我先看看自己和周围的情况。

```text
→ mcp__neteasemc__mc_status {}
← {"ok":true,"mode":"mod","connected":true,"mod":"netease-mc-link/1.0.0","server":"1.21.8","protocol":772}
→ mcp__neteasemc__mc_state {}
← {"ok":true,"player":{"name":"DeepSeek","x":12.5,"y":64.0,"z":-8.5,"health":20,"food":20,
   "gamemode":"survival","dimension":"minecraft:overworld"},
   "world":{"time":6000,"weather":"clear"}}
```

> **DeepSeek**：我在 (12, 64, -8) 的草地上。先找树。

```text
→ mcp__neteasemc__mc_nearby_blocks {"radius":32,"block":"oak_log","limit":10}
← {"ok":true,"blocks":[
     {"x":20,"y":64,"z":-12,"name":"minecraft:oak_log","distance":8.2},
     {"x":21,"y":65,"z":-12,"name":"minecraft:oak_log","distance":8.2},
     {"x":20,"y":66,"z":-12,"name":"minecraft:oak_log","distance":8.2}]}
```

> **DeepSeek**：树在东南方向约 8 格。走过去砍 3 根原木。

```text
→ mcp__neteasemc__mc_move {"x":20,"z":-12}
← {"ok":true,"arrived":true,"position":{"x":20.1,"y":64.0,"z":-12.4}}
→ mcp__neteasemc__mc_mine {"block":"oak_log","count":3}
← {"ok":true,"mined":[{"x":20,"y":66,"z":-12,"name":"minecraft:oak_log"},
                      {"x":20,"y":65,"z":-12,"name":"minecraft:oak_log"},
                      {"x":20,"y":64,"z":-12,"name":"minecraft:oak_log"}],
   "inventory":[{"slot":36,"name":"minecraft:oak_log","count":3}]}
```

> **DeepSeek**：木头到手（3 根）。现在准备木板和小屋材料。

```text
→ mcp__neteasemc__mc_command {"command":"give DeepSeek oak_planks 32"}
← {"ok":true,"output":["Gave 32 [Oak Planks] to DeepSeek"]}
→ mcp__neteasemc__mc_command {"command":"give DeepSeek oak_door 1"}
← {"ok":true,"output":["Gave 1 [Oak Door] to DeepSeek"]}
→ mcp__neteasemc__mc_inventory {}
← {"ok":true,"items":[
     {"slot":0,"name":"minecraft:oak_planks","count":32},
     {"slot":1,"name":"minecraft:oak_door","count":1},
     {"slot":2,"name":"minecraft:torch","count":4}]}
```

> **DeepSeek**：材料齐了。把地基定在出生点东侧 (15, 64, -10)，先铺 5×5 地板，再起墙。
> 会按"先远后近"的顺序放，避免挡路。

```text
→ mcp__neteasemc__mc_move {"x":15,"z":-10}
← {"ok":true,"arrived":true}
→ mcp__neteasemc__mc_place {"x":15,"y":64,"z":-10,"item":"oak_planks"}
← {"ok":true,"block":{"x":15,"y":64,"z":-10,"name":"minecraft:oak_planks"}}
→ mcp__neteasemc__mc_place {"x":16,"y":64,"z":-10,"item":"oak_planks"}
← {"ok":true,...}
...（共 25 次 mc_place 铺地板）
→ mcp__neteasemc__mc_nearby_blocks {"radius":6,"block":"oak_planks","limit":30}
← {"ok":true,"blocks":[{"x":15,"y":64,"z":-10},{"x":16,"y":64,"z":-10}, ... 共 25 个]}
```

> **DeepSeek**：地板完成。接下来沿四边起墙，南面留 1×2 的门洞，最后放门和火把。

```text
→ mcp__neteasemc__mc_place {"x":15,"y":65,"z":-10,"item":"oak_planks"}
← {"ok":true,...}
...（每个墙格一次，共 3 层高、留门洞）
→ mcp__neteasemc__mc_place {"x":17,"y":64,"z":-14,"item":"oak_door"}
← {"ok":true,"block":{"x":17,"y":64,"z":-14,"name":"minecraft:oak_door"}}
→ mcp__neteasemc__mc_place {"x":16,"y":66,"z":-8,"item":"torch"}
← {"ok":true,"block":{"x":16,"y":66,"z":-8,"name":"minecraft:torch"}}
→ mcp__neteasemc__mc_chat {"message":"小木屋建好了，门口有火把。"}
← {"ok":true,"sent":true}
```

> **DeepSeek**：完成 ✅ 5×5×3 的小木屋已建在 (15,64,-10)～(19,66,-6)，南墙留了门洞并装门，
> 屋外插了 4 支火把。消耗 25+36 块木板。需要我再加窗户或屋顶吗？

真实使用建议：

- 把"建房子"拆成"地基 → 墙 → 门 → 屋顶"多轮对话，比一句话更可靠；
- 建造前用 `mc_nearby_blocks` 确认空地，避免压坏原有方块；
- 重要世界先备份存档，或先在超平坦测试世界练习（见 [docs/SECURITY.md](docs/SECURITY.md)）；
- 只有 bot 通道时，木板可在游戏里手动合成后放在快捷栏，再让 `mc_place` 直接使用背包里的物品。

---

## 配置参考

bridge 配置查找顺序：`--config <path>` → 环境变量 `DSH_MC_CONFIG` → `./dsh-mc.config.json`
→ `%USERPROFILE%\.dsh-mc\config.json`。缺失字段用默认值，未知字段忽略。

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

密钥规则：**只能来自环境变量**——`DEEPSEEK_API_KEY`（内置 agent）与 `DSH_MC_TOKEN`（通道 B
的 token）；配置文件与仓库中不得出现明文密钥。配置文件里的 `mod.token` 字段仅为兼容保留，
**bridge 会忽略它并给出告警**。`mode=bot` 需要 `bot.port`；`mode=mod` 需要 `DSH_MC_TOKEN`。

> 注意：DSH 启动 MCP 子进程时会清洗名字匹配 `KEY|PASSWORD|SECRET|TOKEN` 的环境变量。
> 通道 B 下如果工具报 `missing_token`，请在 `cordis.patch.yml` 该条目的 `env:` 里显式加一行
> `DSH_MC_TOKEN: '<token>'`（本地 profile 文件，注意不要提交），或改回通道 A。

### DSH 注册片段（`install.ps1` 自动写入）

`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（**缩进必须是空格**）：

```yaml
- id: mcp-netease-mc
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: neteasemc
    transport: stdio
    command: 'C:\Program Files\nodejs\node.exe'
    args:
      - 'C:\path\to\dsh-netease-mc\packages\bridge\src\index.js'
    env:
      DSH_MC_CONFIG: 'C:\Users\<you>\.dsh-mc\config.json'
```

> DSH 会清洗名字匹配 `KEY|PASSWORD|SECRET|TOKEN` 的环境变量，所以这里只显式给
> `DSH_MC_CONFIG`；不要在该文件里写 API key。改完需重启 DSH。

---

## 目录结构

```text
dsh-netease-mc/
├─ packages/
│  ├─ bridge/            # Node.js MCP 服务器（stdio JSON-RPC）+ mineflayer 通道 + mod HTTP 客户端 + 内置 agent
│  └─ mod/               # 可选：NeoForge 1.21.8 游戏内 HTTP 桥模组（Java）
├─ scripts/
│  ├─ install.ps1        # 检测环境、装依赖、生成配置、注册 DSH（-DryRun/-InstallMod）
│  ├─ uninstall.ps1      # 移除 DSH 注册（-RemoveData/-RemoveMod，自动备份）
│  └─ detect-lan.ps1     # 探测「对局域网开放」端口
├─ docs/
│  ├─ ARCHITECTURE.md    # 唯一接口契约（先读这个）
│  ├─ RESEARCH.md        # 技术调研：网易 Java/基岩差别、ModSDK、协议 772、方案对比
│  ├─ SECURITY.md        # 账号合规、模组风险、token、policy、LLM 安全
│  ├─ FAQ.md             # 常见问题
│  ├─ TROUBLESHOOTING.md # 故障排查
│  └─ CONTRIBUTING.md    # 贡献指南
├─ test/                 # 跨包端到端脚本
├─ .github/workflows/ci.yml
└─ README.md
```

---

## 常见问题与排查

- 快速问答：[docs/FAQ.md](docs/FAQ.md)（LAN 端口、协议不匹配、401、模组不加载、乱码、防火墙…）
- 深入排查：[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)（含诊断命令与日志定位）
- `scripts\detect-lan.ps1` 找不到端口？先用 `node packages\bridge\src\index.js probe` 交叉验证。

---

## 安全声明

- 本项目与网易、Mojang、Microsoft **无隶属关系**，未获其背书；
- 默认通道 A 不改游戏文件；通道 B 的第三方模组**可能违反网易用户协议或触发风控**，
  使用前请阅读 [docs/SECURITY.md](docs/SECURITY.md)，建议仅在测试账号/可恢复存档上使用；
- 不要在仓库、配置文件、日志、聊天中保存网易账号密码、GitHub 凭据或 token；
- 只监听 `127.0.0.1`，不要在公共 Wi-Fi 下开 LAN 世界；
- AI 可能执行破坏性操作：先 `--dry-run`、收紧 `policy`、备份世界。

---

## License

[MIT](LICENSE) © 2026 dsh-netease-mc contributors

Minecraft 是 Mojang Studios 的商标；本项目不包含任何游戏资源。
