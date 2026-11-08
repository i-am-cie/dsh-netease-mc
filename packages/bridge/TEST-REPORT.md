# Bridge 测试报告（TEST-REPORT）

- 生成时间：2026-11-08 19:05（Asia/Shanghai，UTC+8）
- 被测目录：`packages/bridge`（node `v24.16.0`，npm `11.13.0`，Windows 10/11 PowerShell）
- 唯一运行时依赖：`mineflayer@4.39.0`（仅 `mode=bot` 时动态 import）；`mode=mod` 不加载 mineflayer，无 `node_modules` 也可启动。
- 结论：**单元/集成测试全绿（72 pass / 0 fail）**；mod 通道与 bot 通道读类工具由 mock 逐字段比对；**真实 Paper 服务器 + 真实 mineflayer bot 的端到端实测未完成**（服务器 jar 已下载并校验，见 §5），需要真机/人工在 5 分钟时间盒外复跑 `test/e2e/run-e2e.js`。

## 1. 测试命令与结果

### 1.1 全量单元/集成测试（`node --test`，与 DSH/CI 用法一致）

```powershell
cd packages/bridge
node --test
```

真实输出（尾部）：

```
ℹ tests 72
ℹ suites 0
ℹ pass 72
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 8996.431
```

耗时约 9.1 s，进程自行退出（无悬挂句柄）。测试文件分布：

| 文件 | 内容 | 结果 |
|---|---|---|
| `test/config.test.js` | 配置查找顺序 `--config` → `DSH_MC_CONFIG` → `./dsh-mc.config.json` → `~/.dsh-mc/config.json`、默认值、未知字段忽略、非法 JSON/mode、密钥只从环境变量读、mode 就绪校验 | 7/7 |
| `test/policy.test.js` | 6 个权限位分别拦截对应工具、chat 读写独立拦截、结构化 `operation_not_allowed` | 5/5 |
| `test/normalize.test.js` | 14 个工具的统一返回结构、四舍五入/排序/命名空间剥离、错误结构、`tools/list` schema、参数校验与数字字符串强转 | 8/8 |
| `test/mod.test.js` | mock mod HTTP 服务器覆盖**全部 14 个工具**（含 `/health`、`/state`、`/inventory`、`/blocks`、`/entities`、`/block`、`/chat`、`/command`、`/action`），token 缺失/错误、401/5xx/非 JSON/超时/不可达错误映射、策略拦截不发请求 | 22/22 |
| `test/bot-read.test.js` | 用 fake mineflayer bot 对 bot 通道读类工具做单测，并与 mod 通道结果 **deepEqual 逐字段比对**（state/players/inventory/nearby_entities/nearby_blocks/block/chat）；`includeEmpty`；`mc_command` 固定 `unsupported_in_bot_mode`；懒加载校验（require 入口不加载 mineflayer） | 13/13 |
| `test/bot-errors.test.js` | 连接被拒绝不崩溃、结构化 `bot_not_connected`、指数退避重连已调度、mineflayer 缺失清晰报错、`mc_status` 非阻塞、非法端口 | 4/4 |
| `test/agent.test.js` | mock OpenAI 兼容服务器驱动 DeepSeek function-calling 循环：多步工具调用→最终回答、工具结果回填、`--dry-run` 不执行、`--max-steps`、缺 key/goal、API 5xx、非法 tool_call args、已 abort 信号 | 8/8 |
| `test/mcp.test.js` | **真实子进程** `node src/index.js serve` + NDJSON 管道：initialize（协议 `2025-06-18`）、notifications/initialized、ping、tools/list（14 个工具）、tools/call 成功/未知工具/坏参数、resources/list、prompts/list、未知方法 -32601、坏 JSON -32700、stdout 纯 JSON-RPC、stdin 关闭后进程退出 0；另测“探测进程”模式：bot 模式只 list tools 不发起连接 | 2/2 |

> 说明：Node 24 的 `node --test` 会把 `test/` 目录下所有 `.js` 都当作测试文件执行；`test/e2e/run-e2e.js` 顶部有 `NODE_TEST_CONTEXT` 守卫，在被测试发现时立即成功退出，因此不会启动真实服务器；`test/helpers/*.js` 无测试用例，执行即通过。真实 e2e 必须显式 `node test/e2e/run-e2e.js`。

### 1.2 手工 JSON-RPC 管道验证（不经测试框架）

```powershell
@('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mc_status","arguments":{}}}') |
  node src/index.js serve
```

真实输出（截断）：

```
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false},...},"serverInfo":{"name":"dsh-netease-mc-bridge",...
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"mc_status",...
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"ok\":true,\"mode\":\"bot\",\"connected\":false,\"server\":{\"host\":\"127.0.0.1\",\"port\":25565,\"version\":\"1.21.8\"},\"mod\":null,...
```

stdout 只有 JSON-RPC 行；日志全部走 stderr；无服务器时 `mc_status` 仍立即返回 `connected:false`，不崩溃。

### 1.3 CLI 子命令冒烟

```powershell
node src/index.js doctor   # → ok:true，configSource:"home"，已识别 ~/.dsh-mc/config.json，token/apiKey present:false
node src/index.js probe    # → {"ok":true,"host":"127.0.0.1","scanned":1,"openPorts":[]}
```

## 2. 通道 B（mod）mock 覆盖细节

mock 服务器按 **mod 作者实测返回形状** 实现（不是照抄契约猜测）：

- `GET /inventory` → `{ok:true, inventory:[...], slots:[...]}`；bridge 优先 `inventory`，回退 `slots`（兼容两种）。
- `GET /blocks` → `{ok:true, blocks:[...]}`；`GET /entities` → `{ok:true, entities:[...]}`。
- `GET /block` → `{ok:true, block:{id, properties, solid}, blockEntity:{id,type}|null}`；`id` 映射为统一 `name`，`blockEntity` 取顶层字段。
- `GET /state` 按契约；错误统一 `{ok:false,error:{code,message}}`；`/health` 免鉴权。
- 请求头同时带 `Authorization: Bearer <token>` 与 `X-MC-Token`；token 只从 `DSH_MC_TOKEN` 环境变量读取，配置文件里的 token 被忽略并告警。
- `/command` 的 `ok:true` 仅表示命令受理，bridge 原样返回 `output` 数组，不伪造执行成功。
- 错误映射实测：缺 token→`missing_token`；401→`mod_unauthorized`；5xx→mod 返回的错误码；非 JSON→`mod_invalid_response`；连接拒绝→`mod_unreachable`；超时→`timeout`；404 `/block`→`block_not_loaded`。

## 3. 通道 A（bot）测试覆盖细节

- 连接失败（端口拒绝）：`ensureConnected` 返回 `bot_not_connected`，进程不退出，`lastError` 保留 `connection_refused`，已调度指数退避重连；关闭时清理 minecraft-protocol 的 30s close-safety timer（否则进程会多存活 30s，已修复并验证）。
- `mode=mod` 且无 `node_modules`：入口 require 不加载 mineflayer（单测断言）；mod 通道所有测试未安装/未加载 mineflayer 也通过。
- 读类工具（state/players/inventory/nearby_entities/nearby_blocks/block/chat-read）在 fake bot 上的输出与 mod 通道输出 **逐字段 deepEqual**，满足“工具输出必须一模一样”。
- 写类工具（move/mine/place/use/attack）与真实物理/服务器交互只能在真实服务器上验证，见 §5。

## 4. 自主代理循环（`agent`）

mock OpenAI 兼容服务器实测：工具集 = 14 个 MCP 工具（无 `mc_agent`）；每步把上一工具结果以 `role:"tool"` 回填；`--dry-run` 只返回计划不执行；`--max-steps` 生效；缺 `DEEPSEEK_API_KEY` / 缺 goal / API 5xx 均给出结构化错误；非法 tool_call arguments 不会崩溃。全程未消耗真实 API 配额（测试用 `fetchImpl`/本地 mock）。

## 5. 真实 Paper 1.21.8 + 真实 bot 端到端（**未实测完成**）

已完成的真实步骤：

1. 从 Paper fill v3 API 获取 1.21.8 build 60 下载地址并成功下载：
   - 文件：`test-servers/paper-1.21.8-60.jar`（52,811,717 bytes）
   - SHA256：`8de7c52c3b02403503d16fac58003f1efef7dd7a0256786843927fa92ee57f1e`（与 API 返回一致）
2. JDK 22 存在：`D:\MCLDownload\ext\jre-v64-220420\jdk22\bin\java.exe`。
3. 实测脚本已写好：`packages/bridge/test/e2e/run-e2e.js`，会：建 `test-servers/server-1.21.8/`（online-mode=false、eula=true、port 25565、超平坦、和平）、启动 Paper、用 `node src/index.js serve` 的 bot 通道真实加入、逐个调用并断言：
   - `mc_status`（连接成功）、`mc_state`、`mc_inventory`（等待控制台 `give DeepSeek oak_planks 16` 后确认木板）、`mc_players`、`mc_block`（脚下为实心）、`mc_nearby_blocks`、`mc_nearby_entities`、
   - `mc_move`（真实走到坐标，校验位移 >1.5）、`mc_mine`（真实挖掉草原方块并用 `mc_block` 校验已变化）、`mc_place`（放置 oak_planks 并校验）、`mc_chat`（发送 + 读回含 e2e 文本）、`mc_command`（bot 模式必须 `unsupported_in_bot_mode`）。
   - 结果写入 `test-run/e2e-results.json` 与 `test-run/e2e-run.log`。

**未实测原因（如实记录）**：本轮任务时间盒到点（Lead 指示 5 分钟内收敛、不要在真机上死磕）；Paper 首次启动需下载 Mojang 库且完整流程约 2–4 分钟，故未在本轮执行服务器启动与 bot 加入。**结论：真实 bot 通道的移动/挖掘/放置/聊天仍未在真机验证，mock/fake-bot 单测不覆盖真实物理与协议交互。**

复跑命令（有足够时间时）：

```powershell
cd packages/bridge
node test/e2e/run-e2e.js
# 期望：RESULT: 15/15 checks passed，退出码 0
```

真机（网易客户端「对局域网开放」）验证步骤（待用户/Lead 执行）：

1. 网易客户端进入世界 →「对局域网开放」，得到 LAN 端口（随机，通常 49152–65535）。
2. `node src/index.js probe --range 49152-65535` 找开放端口。
3. 写配置 `{"mode":"bot","bot":{"host":"127.0.0.1","port":<LAN端口>,"username":"DeepSeek","version":"1.21.8"}}`，或用 `node src/index.js serve --port <LAN端口>`。
4. 依次调用 `mc_status` → `mc_state` → `mc_move`/`mc_mine`/`mc_place`/`mc_chat` 确认。

## 6. 遗留风险

1. **真实服务器 e2e 未完成**（见 §5）：walker 为内置实现（未引入 `mineflayer-pathfinder` 依赖），已处理障碍跳跃/侧移，但复杂地形/跨层寻路可能超时；真实 LAN 端口、网易客户端兼容性未验证。
2. **真实 mod jar 联调未做**：bridge 按 Lead 提供的真实返回形状兼容（`inventory`/`slots` 双别名、`/block.blockEntity`、`/command` 受理语义），但 `mc_move/mine/place/use/attack` 走 `/action` 扩展类型（契约 §5 未列出、mod 侧可能未实现这几个 action type），真实 mod 联调时可能返回 `unsupported_action`，需要 mod 侧补齐或改用命令通道。
3. `mc_move` 的 y 轴：bot 通道仅水平寻路 + 重力/跳跃；目标在显著高/低层时可能失败（返回 `timeout`）。
4. `mc_place` 依赖背包/手持方块；bot 模式无法通过聊天获得物品，需事先由玩家/服务器给予（或使用 mod 通道 `mc_command give`）。
5. 配置解析只支持 JSON（不支持注释/JSON5）。
6. Node 24 `node --test` 会把 `test/` 下所有文件当测试执行；已用 `NODE_TEST_CONTEXT` 守卫 e2e 脚本，若未来新增 helper 需保持无副作用。

## 7. 交付文件

```
packages/bridge/
├─ package.json              # name dsh-netease-mc-bridge, type commonjs, 唯一依赖 mineflayer
├─ src/index.js              # 手写 MCP JSON-RPC 2.0 over NDJSON stdio（协议 2025-06-18）
├─ src/cli.js                # serve / agent / doctor / probe
├─ src/config.js             # 配置查找顺序、默认值、密钥只读环境变量
├─ src/errors.js             # ToolError / RpcError / toErrorResult
├─ src/logger.js             # 结构化 JSON 日志（只写 stderr，tool 调用记录 ts/tool/args/ok/ms）
├─ src/policy.js             # 6 个权限闸门
├─ src/normalize.js          # 两条通道统一返回结构
├─ src/tools.js              # 14 个工具注册表 + JSON Schema + 参数校验 + OpenAI tools 转换
├─ src/executor.js           # 懒连接/策略/超时/错误映射/工具日志
├─ src/game/bot.js           # 通道 A：mineflayer 懒加载、重连退避、全部 bot 工具
├─ src/game/mod.js           # 通道 B：mod HTTP 客户端（真实形状兼容）
├─ src/agent/deepseek.js     # DeepSeek function-calling 自主循环
├─ test/*.test.js            # 72 个测试全部通过
├─ test/helpers/             # mock mod HTTP 服务器（真实形状）、配置构造
├─ test/e2e/run-e2e.js       # 真实 Paper + bot e2e（已写，未跑完）
└─ TEST-REPORT.md            # 本文件
```
