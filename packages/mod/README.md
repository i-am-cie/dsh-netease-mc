# Netease MC Link（packages/mod）

网易 Java 版（NeoForge 21.8.52 / Minecraft 1.21.8）游戏内 HTTP 桥模组，供
`dsh-netease-mc` 的 bridge（通道 B）调用。模组只监听本机回环地址，强制 token 鉴权。

- 监听：`http://127.0.0.1:38210`（可在 config 中改）
- 鉴权：`Authorization: Bearer <token>` 或 `X-MC-Token: <token>`
- 契约：`docs/ARCHITECTURE.md` 第 5 节

## 安装

1. 构建（在仓库根目录；需要本机 JDK22 与已安装的 NeoForge 实例，不需要 Gradle/网络）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File packages\mod\build.ps1
   ```

   产物：`packages\mod\build\netease-mc-link-1.0.0.jar`。

2. 复制到游戏实例的 `mods/` 目录：

   ```powershell
   Copy-Item packages\mod\build\netease-mc-link-1.0.0.jar 'D:\netease_minecraft_neoforge\mods\'
   ```

3. 启动游戏并进入一个世界（单机或局域网均可；模组在服务器启动后才监听端口）。

4. 首次启动会生成 `D:\netease_minecraft_neoforge\config\netease_mc_link.json`，里面包含随机
   token；同一 token 也会打印在游戏日志中（`[netease_mc_link] token ...`）。

## 自检

```powershell
# 存活探测（免鉴权）
curl.exe http://127.0.0.1:38210/health
# -> {"ok":true,"mod":"netease_mc_link","mc":"1.21.8","port":38210}

# 读取 token
$cfg = Get-Content 'D:\netease_minecraft_neoforge\config\netease_mc_link.json' -Raw | ConvertFrom-Json
$token = $cfg.token

# 读取状态（需要至少一个玩家在线）
curl.exe -H "X-MC-Token: $token" http://127.0.0.1:38210/state

# 执行命令
curl.exe -X POST -H "X-MC-Token: $token" -H "Content-Type: application/json" `
  -d '{\"command\":\"time set day\"}' http://127.0.0.1:38210/command

# 聊天
curl.exe -X POST -H "X-MC-Token: $token" -H "Content-Type: application/json" `
  -d '{\"message\":\"hello from DSH\"}' http://127.0.0.1:38210/chat

# 高层动作：给自己发 64 个钻石
curl.exe -X POST -H "X-MC-Token: $token" -H "Content-Type: application/json" `
  -d '{\"type\":\"give\",\"item\":\"diamond\",\"count\":64}' http://127.0.0.1:38210/action

# 传送到坐标
curl.exe -X POST -H "X-MC-Token: $token" -H "Content-Type: application/json" `
  -d '{\"type\":\"tp\",\"x\":0,\"y\":80,\"z\":0}' http://127.0.0.1:38210/action
```

## 配置

`<gameDir>/config/netease_mc_link.json`（首次启动自动生成，可手工修改后重启游戏生效）：

```json
{
  "port": 38210,
  "bind": "127.0.0.1",
  "token": "<64 位十六进制随机串>",
  "allowCommands": true,
  "allowChat": true,
  "allowActions": true,
  "_comment": "Local-only HTTP bridge for dsh-netease-mc. Keep this token secret; ..."
}
```

- `bind` 仅接受回环地址（`127.0.0.1` / `localhost` / `::1`）；其他值会被强制改回 `127.0.0.1` 并写日志。
- 删除 token 或写成非法值会自动重新生成。
- 配置文件损坏时会改名为 `netease_mc_link.json.broken-<时间戳>` 并重新生成。

## 端点

| 方法/路径 | 说明 | 主要返回字段 |
|---|---|---|
| `GET /health` | 免鉴权存活探测 | `ok, mod, mc, port` |
| `GET /state[?player=名字]` | 玩家/世界状态 | `player{name,uuid,x,y,z,yaw,pitch,health,food,gamemode,dimension,level,exp}, world{time,day,weather,difficulty}, players[{name,x,y,z,health}]` |
| `GET /inventory[?player=名字&includeEmpty=true]` | 背包槽位 | `player, slots[{slot,name,displayName,count,durability?}], inventory`（`inventory` 与 `slots` 内容相同，兼容别名） |
| `GET /block?x=&y=&z=` | 单方块 | `x,y,z,id,properties,solid,blockEntity{id,type}\|null` |
| `GET /blocks?radius=&block=&limit=` | 附近方块（默认 radius=8，上限 16；跳过空气；按距离升序；limit 上限 500） | `blocks[{x,y,z,id,distance}], count, radius, limit` |
| `GET /entities?radius=&type=&limit=` | 附近实体（默认 radius=16，上限 64；排除自己/旁观者；按距离升序；limit 上限 200） | `entities[{id,name,type,x,y,z,distance}], count, radius, limit` |
| `POST /command` | `{"command":"time set day"}` 以权限 4 执行 | `command, output[...]` |
| `POST /chat` | `{"message":"hi"}` 以当前玩家身份发言 | `player, message, delivered` |
| `POST /action` | 高层动作 `{"type":"..."}`，类型见下 | `type, command, output[...]` |

`/state`、`/inventory`、`/blocks`、`/entities` 的 `player` 参数可指定在线玩家名；缺省取第一个在线玩家。
`/block` 的维度跟随第一个在线玩家（无玩家时为主世界）。
`/command` 在没有在线玩家时仍可用（控制台身份）；`/chat`、需要玩家的 `action` 在无玩家时返回
`409 no_player`。

### `/action` 类型

| type | 必填参数 | 可选参数 | 对应命令 |
|---|---|---|---|
| `tp` | `x,y,z` 或 `to`（在线玩家名） | `player`（被传送者） | `tp <player> <x y z>` / `tp <player> <to>` |
| `give` | `item` | `count`(1–6400), `player` | `give <player> <item> <count>` |
| `setblock` | `x,y,z,block` | — | `setblock <x> <y> <z> <block>` |
| `summon` | `entity` | `x,y,z`（缺省用玩家位置）, `player` | `summon <entity> <x y z>` |
| `time` | `value`（`day\|noon\|night\|midnight\|tick 数`） | — | `time set <value>` |
| `weather` | `value`（`clear\|rain\|thunder`） | `duration` | `weather <value> [duration]` |
| `gamemode` | `value`（`survival\|creative\|adventure\|spectator`） | `player` | `gamemode <value> <player>` |
| `effect` | `effect` | `duration`(秒), `amplifier`, `player` | `effect give <player> <effect> <secs> <amp> true` |
| `kill` | — | `player` | `kill <player>` |

物品/方块/实体/效果 id 接受 `minecraft:diamond` 或 `diamond`（自动补 `minecraft:` 前缀），
会先做注册表校验，未知 id 返回 `unknown_*` 错误。

## 错误格式

所有错误响应为：

```json
{"ok": false, "error": {"code": "unauthorized", "message": "..."}}
```

状态码：400 `bad_request` / `unknown_*` / `unsupported_action`，401 `unauthorized`，403 `policy_denied`
（config 开关关闭），404 `not_found` / `player_not_found`，405 `method_not_allowed`，409 `no_player`，
413 `payload_too_large`，503 `server_not_ready`，504 `timeout`，500 `internal`。

## 与 bridge 对接

`~/.dsh-mc/config.json`（或 `DSH_MC_CONFIG` 指定文件）中：

```json
{
  "mode": "mod",
  "mod": {
    "url": "http://127.0.0.1:38210",
    "token": "<config/netease_mc_link.json 里的 token>",
    "timeoutMs": 5000
  }
}
```

## 卸载

1. 关闭游戏，删除 `D:\netease_minecraft_neoforge\mods\netease-mc-link-1.0.0.jar`。
2. 如不再使用，可同时删除 `config/netease_mc_link.json`。重启游戏即恢复原状。

## 安全提示

- 模组以**服务器权限**运行，`/command`、`/action` 等于控制台级操作；token 泄漏 = 游戏内最高权限。
- 只监听回环地址，不要改 `bind` 为非本机地址（配置层也会拒绝）。
- 第三方 NeoForge 模组在网易客户端上的加载与风控无官方保证，使用前请自行评估（见 `docs/SECURITY.md`）。
- 本模组**未在真机加载验证**，详见 `NOTES.md` §5。
