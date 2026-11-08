# 故障排查（Troubleshooting）

> 先跑一遍内置诊断：`cd packages\bridge; node src\index.js doctor`。
> 每个小节按「现象 → 定位 → 处理」组织。命令在仓库根目录、PowerShell 下执行。

---

## 0. 通用信息采集

遇到问题先收集以下信息，能解决 80% 的排查：

```powershell
node --version
cd packages\bridge
node src\index.js doctor
node src\index.js probe
Get-Content "$env:USERPROFILE\.dsh-mc\config.json"
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml"
```

游戏侧日志：`<GameDir>\logs\latest.log`（`<GameDir>` 默认 `D:\netease_minecraft_neoforge`）。
**分享前先脱敏**（token、账号、服务器地址）。

---

## 1. LAN 端口探测不到

**现象**：`detect-lan.ps1` 输出 `No LAN port detected`。

**定位**：

```powershell
# 游戏是否在运行？
Get-Process javaw, java -ErrorAction SilentlyContinue
# 日志里有没有 LAN 行？
Select-String -Path "D:\netease_minecraft_neoforge\logs\latest.log" -Pattern 'LAN|port'
# 端口是否在监听？
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -ge 1024 } |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

**处理**：

1. 确认世界已"对局域网开放"（Esc → 对局域网开放 → 确认），不是只有单人世界；
2. `-GameDir` 指对实例目录；网易启动器可能把日志放在实例目录而非启动器目录；
3. 某些网易版本日志文案不同，脚本没匹配到时会退化为 netstat 检测：
   `javaw.exe` 的 LISTENING 端口即候选；用 PID 对照：
   `Get-NetTCPConnection -OwningProcess <pid> -State Listen`；
4. 如果日志里的端口是旧的（世界已退出），netstat 才是当前真相；反过来游戏刚启动
   netstat 可能还没监听，两种来源都看；
5. 仍不行：在游戏里按 `F3` 看右上方 LAN 信息，或临时用固定端口工具（不推荐）。

---

## 2. mineflayer 连接失败：协议/版本不匹配

**现象**：`unsupported protocol version`、`Failed to connect`、登录后立刻被踢。

**定位**：

```powershell
cd packages\bridge
node -e "const mc=require('minecraft-data'); for (const v of ['1.21.8','1.21.7']) { const d=mc(v); console.log(v, d && d.version && d.version.version, d && d.version && d.version.minecraftVersion); }"
npm ls mineflayer minecraft-data node-minecraft-protocol
```

**处理**：

1. 配置固定 `"version": "1.21.8"`；
2. `npm install mineflayer@latest minecraft-data@latest` 后重测；
3. 登录后立刻被踢通常不是协议问题，而是服务端要求客户端模组/白名单：
   看游戏日志里的 disconnect 原因；必要时改通道 B；
4. 网易 LAN 世界如果开启了"仅正版验证"，机器人无法登录——关闭正版验证或改用通道 B。

---

## 3. 连接被拒绝（ECONNREFUSED / ETIMEDOUT）

**现象**：`connect ECONNREFUSED 127.0.0.1:xxxxx`。

**定位**：

```powershell
Test-NetConnection 127.0.0.1 -Port <port> -InformationLevel Detailed
```

**处理**：

- `TcpTestSucceeded: False`：端口错/世界已关/端口变了 → 重新 `detect-lan.ps1`；
- 连接超时：`host` 写成了局域网 IP 但本机防火墙拦截；改为 `127.0.0.1`；
- WSL/容器里跑 bridge 连宿主机的 127.0.0.1 会失败：bridge 必须和游戏在同一台 Windows 上，
  或使用 `host.docker.internal` 并放行回环。

---

## 4. 通道 B：401 / 403 / `missing_token`

**现象**：`GET /health` 正常，其他接口返回 401；或工具报 `missing_token`。

**定位**：

```powershell
$token = (Get-Content "D:\netease_minecraft_neoforge\config\netease_mc_link.json" | ConvertFrom-Json).token
curl.exe -s -H "Authorization: Bearer $token" http://127.0.0.1:38210/state
```

**处理**：

1. token 每次重装/删除配置后都会重新生成，复制最新值；
2. bridge **只从环境变量 `DSH_MC_TOKEN` 读取 token**，配置文件里的 `mod.token` 会被忽略
   （设置后会有 warning）；`setx DSH_MC_TOKEN "<token>"` 后重开终端并**重启 DSH**；
3. DSH 会清洗名字匹配 `KEY|PASSWORD|SECRET|TOKEN` 的环境变量：若 MCP 子进程拿不到，
   在 `cordis.patch.yml` 该条目的 `env:` 里显式写 `DSH_MC_TOKEN: '<token>'`（勿提交该文件）；
4. 不要在公开终端里直接打印 token；用 `Read-Host -AsSecureString` 或临时变量。

---

## 5. 通道 B：模组不加载 / 游戏崩溃

**现象**：`mods/` 里有 jar，游戏启动后日志无模组名，或启动崩溃。

**定位**：

```powershell
Select-String -Path "D:\netease_minecraft_neoforge\logs\latest.log" -Pattern 'netease-mc-link|ERROR|Exception' |
  Select-Object -First 50
# 崩溃报告
Get-ChildItem "D:\netease_minecraft_neoforge\crash-reports" -ErrorAction SilentlyContinue
```

**处理**：

1. 确认 jar 对应 **NeoForge 1.21.8**（`mods.toml` 的 `versionRange`/`loaderVersion`）；
2. 模组只从本仓库构建：`cd packages\mod` 后按 README 构建；
3. 移走其他第三方模组，只保留 `netease_official` + 本模组做对照；
4. 用 `-RemoveMod` 卸载后确认游戏能正常启动，说明问题来自模组；
5. 网易客户端更新后模组可能失效，等适配或改用通道 A。

---

## 6. 环境缺失：Node.js / JDK

**现象**：`node : 无法将"node"项识别为...` 或 `javac not found`。

**处理**：

- Node.js 必须 **20+**（bridge 的 `engines` 要求）；`node --version` 确认；
- JDK 只有构建模组时需要：JDK 21/22，`javac -version` 确认；
- 安装后**重开终端**（PATH 不会热更新），再重跑 `install.ps1`；
- 若 PATH 里有多版本，用绝对路径传参：`-NodeExe "C:\Program Files\nodejs\node.exe"`。

---

## 7. DeepSeek API 401 / 429

**现象**：内置 agent 输出 `401 Unauthorized` 或 `429 Too Many Requests`。

**处理**：

- 401：key 缺失/错误/吊销 → 重新设置环境变量并重启 DSH；确认没有多余空格/引号；
- 429：限流 → 降低并发、增大重试间隔、减少 `maxSteps`；检查账户余额；
- 网络：公司代理下设置 `HTTPS_PROXY`，并确认 `NO_PROXY` 包含 `127.0.0.1`；
- 不想用内置 agent 时，直接在 DSH 对话里调用 MCP 工具即可（不需要 DeepSeek key）。

---

## 8. 中文乱码

**现象**：日志/聊天中的中文显示为 `??` 或乱码方块。

**处理**：

1. 终端：`chcp 65001`，或改用 Windows Terminal + PowerShell 7；
2. 文件：`config.json`、日志用 UTF-8 保存（无 BOM）；
3. 输出重定向时 `Out-File -Encoding utf8`（PS 5.1 请用 `utf8BOM` 避免部分工具识别失败）；
4. 分享日志给他人前统一转 UTF-8 并脱敏。

---

## 9. 端口占用（38210 / LAN 端口）

**现象**：模组报 `Address already in use`；或 bot 连到了别的服务。

**处理**：

```powershell
Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 38210 |
  Select-Object LocalAddress,LocalPort,OwningProcess
Get-Process -Id <pid>
```

换端口：改 `<gameDir>\config\netease_mc_link.json` 的端口 + `config.json` 的 `mod.url`，
重启游戏与 DSH。LAN 端口被占用时重新开世界即可（系统会换端口）。

---

## 10. 防火墙 / 杀软 / 公司网络

**现象**：本机 `Test-NetConnection` 正常，但 bridge 连不上；或 DSH 拉不起子进程。

**处理**：

- 回环通常不受防火墙影响；若杀软"网络防护"拦截 `node.exe`，添加**仅本机/专用网络**例外；
- 企业策略可能禁止子进程网络：让 IT 放行 `node.exe` 与 `javaw.exe`；
- 代理软件（Clash 等）开启 TUN 模式可能劫持回环：把 `127.0.0.1/8` 加入直连；
- 安装脚本被 ExecutionPolicy 拦截：用 `powershell -ExecutionPolicy Bypass -File ...`。

---

## 11. DSH 看不到 MCP 工具 / MCP 启动即退出

**现象**：DSH 工具列表无 `mcp__neteasemc__*`，或日志里 MCP 连接失败。

**定位**：

```powershell
# 1) 手动以 stdio 启动，看是否直接退出
$env:DSH_MC_CONFIG="$env:USERPROFILE\.dsh-mc\config.json"
node packages\bridge\src\index.js
# 2) 检查 patch 文件
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml"
```

**处理**：

- 看 stderr：常见为 `Cannot find module 'mineflayer'`（去 `packages/bridge` 执行
  `npm install --omit=dev`）或配置路径错误；
- 确保 `command` 是 **node 的绝对路径**、`args` 里 bridge 入口是绝对路径；
- `cordis.patch.yml` 必须是合法 YAML（缩进用空格）——`scripts\install.ps1` 写入前会校验；
- 修改后必须重启 DSH；`install.ps1` 重跑会自动更新条目（有 `.bak-<时间戳>` 备份）。

---

## 12. 机器人卡住 / 寻路失败 / 挖不到方块

**现象**：`mc_move` 超时、`mc_mine` 找不到方块。

**处理**：

- 长距离移动拆成多段（每段 ≤ 30 格），复杂地形手动搭桥；
- `mc_mine` 的 `block` 用完整 ID（`minecraft:oak_log`）或短名（`oak_log`），
  并用 `mc_nearby_blocks` 先确认坐标与半径；
- 目标方块在脚下/头顶时先 `mc_move` 调整站位；
- 工具类（镐/斧）不在手边时先 `mc_use` 装备；耐久耗尽需换工具；
- 服务器反作弊可能限制移动速度，降低操作频率。

---

## 13. 卸载不干净 / 想恢复原状

```powershell
# 移除 DSH 注册（保留配置）
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
# 移除注册 + 删除配置目录
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -RemoveData
# 若装过通道 B 模组
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -RemoveMod
```

所有对 `cordis.patch.yml` 的修改前都有 `.bak-<时间戳>` 备份，可手工恢复。
