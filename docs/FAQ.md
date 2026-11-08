# 常见问题（FAQ）

> 排查更复杂的故障见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
> 命令默认在仓库根目录执行，PowerShell 环境。

## 1. Minecraft 的"对局域网开放"端口是多少？每次都变吗？

LAN 端口是**随机**的，每次点"对局域网开放"都可能不同，退出世界即失效。自动探测：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\detect-lan.ps1
```

脚本会同时读 `<GameDir>\logs\latest.log` 里的 `Local game hosted on port <port>` 和
`javaw.exe` 进程的 LISTENING 端口，输出建议的 `bot.port`。把结果填进
`%USERPROFILE%\.dsh-mc\config.json` 的 `bot.port`，然后重连。

## 2. 报 `unsupported protocol version` / mineflayer 连不上 1.21.8 怎么办？

先确认配置里 `"version": "1.21.8"`（不要写 `"auto"`），然后检查依赖版本：

```powershell
cd packages\bridge
npm install mineflayer@^4.39.0
node -e "console.log(require('minecraft-data')('1.21.8').version)"
```

如果 `minecraft-data` 没有 1.21.8 数据，升级依赖：`npm install minecraft-data@latest mineflayer@latest`。
仍然失败时可临时把 `version` 改成协议号相同的最近版本（如 `1.21.7`）试连——
但这是**降级验证**，成功不代表数据字段完全正确。详见 RESEARCH.md 第 4 节。

## 3. 报 `ECONNREFUSED` / 连接被拒绝？

99% 是端口不对或世界没开 LAN：

1. 确认游戏里已经"对局域网开放"，且世界还在运行；
2. 重跑 `scripts\detect-lan.ps1`，确认端口；
3. `Test-NetConnection 127.0.0.1 -Port <port>` 应为 `TcpTestSucceeded : True`；
4. 确认 `config.json` 的 `mode` 是 `"bot"`、`bot.host` 是 `127.0.0.1`；
5. 如果刚退出重进世界，端口变了，重新探测。

## 4. 通道 B 报 401 / `unauthorized` / `missing_token`？

token 不对或没注入。bridge **只从环境变量 `DSH_MC_TOKEN` 读取 token**（配置文件里的
`mod.token` 会被忽略并告警）：

1. 打开 `<GameDir>\config\netease_mc_link.json` 复制 `token`（首次启动生成，
   同时会打印在游戏日志里）；
2. 在系统环境变量里设置 `DSH_MC_TOKEN=<token>`，**重开终端**；DSH 会清洗名字含 `TOKEN`
   的环境变量，若 MCP 子进程仍拿不到，就在 `cordis.patch.yml` 的该条目 `env:` 里显式写
   `DSH_MC_TOKEN: '<token>'`（本地文件，勿提交）；
3. 改了 token 后必须**重启 DSH**（MCP 子进程只在启动时读环境变量）；
4. 用 `curl` 验证：`curl -H "Authorization: Bearer <token>" http://127.0.0.1:38210/health`。

## 5. 模组不加载 / `mods` 里放了 jar 但游戏里没反应？

1. 确认 jar 是 **NeoForge 1.21.8** 构建、且没有装进错误的 `mods` 目录；
2. 看 `<GameDir>\logs\latest.log` 是否出现模组名与版本；没有则说明没被扫描到；
3. 检查是否与 `netease_official` 或其他模组冲突（先只留本模组试一次）；
4. 需要**完全退出游戏再启动**，不能只退出世界；
5. 通道 B 不可用时退回通道 A（bot），不要卡在模组上。

## 6. 报 `javac` / JDK 找不到，但只想用 bot 通道？

通道 A 不需要 JDK。只有构建通道 B 的模组才需要 JDK 21/22：

```powershell
& 'D:\MCLDownload\ext\jre-v64-220420\jdk22\bin\javac.exe' -version
```

如果只是安装 bridge，可忽略 `install.ps1` 的 JDK 警告；要构建模组则设置 `JAVA_HOME`
或把 JDK 路径加入 PATH。

## 7. DeepSeek API 返回 401 / `invalid api key`？

```powershell
$env:DEEPSEEK_API_KEY   # 应输出 sk-...，不要 echo 到聊天/截图
```

- 没有值：新开终端 `setx DEEPSEEK_API_KEY "sk-..."`，然后**重开 DSH**；
- 有值但 401：去 DeepSeek 平台确认 key 未吊销、余额正常、无 IP 白名单限制；
- 注意：DSH 的 stdio 环境会清洗名字含 `KEY` 的变量，内置 agent 模式请让 bridge
  从**系统环境**读取（`agent.apiKeyEnv` 默认 `DEEPSEEK_API_KEY`），不要把 key 写进 YAML。

## 8. 中文乱码 / 聊天里中文变问号？

- 确认 bridge 与游戏日志使用 UTF-8；Windows 终端先执行 `chcp 65001`；
- 用 PowerShell 7（`pwsh`）或 Windows Terminal 运行脚本，避免 GBK 控制台；
- 配置文件用 UTF-8 保存（无 BOM），`config.json` 不要用记事本另存为 ANSI；
- 游戏内聊天由 mineflayer 按 UTF-8 编解码；若仍乱码，贴出 `mc_chat {"read":true}`
  的原始返回与日志行，便于定位是发送端还是显示端问题。

## 9. 端口 38210 被占用怎么办？

```powershell
Get-NetTCPConnection -LocalPort 38210 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

关掉占用进程，或改模组端口：模组配置在 `<GameDir>\config\netease_mc_link.json`
（改 `port`），同时改 `~/.dsh-mc/config.json` 的 `mod.url`，重启游戏与 DSH。
不要用系统保留端口（`netsh int ipv4 show excludedportrange protocol=tcp` 可查）。

## 10. 防火墙/杀毒软件拦截了本机连接？

正常情况下回环连接不需要放行。若确实被拦：

- 只给 `node.exe` 和 `javaw.exe` 放行**专用网络/回环**，不要放行公网；
- 用 `Test-NetConnection 127.0.0.1 -Port <port>` 验证；
- 公司电脑可能强制代理，检查 `HTTP_PROXY` 是否影响访问 `127.0.0.1`
  （应设置 `NO_PROXY=127.0.0.1,localhost`）。

## 11. bot 模式下 `mc_command` 为什么报错？

按契约，`mc_command` **只在通道 B（mod）可用**。bot 是普通玩家，没有服务器控制台权限。
需要命令时：改用通道 B，或在游戏输入框手动执行；bot 侧可用 `mc_chat` 发言。
错误码固定为 `unsupported_in_bot_mode`，**不会伪造成功**。

## 12. DSH 里看不到 `mcp__neteasemc__*` 工具？

1. 确认 `~/.dsh/profiles/desktop/cordis.patch.yml` 里有 `mcp-netease-mc` 条目
   （`install.ps1` 会打印路径）；
2. **重启 DSH**（或重新加载 profile），MCP 服务在启动时拉起；
3. 手动验证 bridge 能启动：

   ```powershell
   $env:DSH_MC_CONFIG = "$env:USERPROFILE\.dsh-mc\config.json"
   node packages\bridge\src\index.js --help
   ```

4. 若仍无工具，看 DSH 日志里 `mcp-netease-mc` 的 stderr；常见原因是 node 路径错误、
   `config.json` 不存在或 JSON 语法错误。

## 13. 换电脑 / 换实例目录后要改什么？

重跑安装脚本并覆盖参数即可（脚本幂等）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -GameDir "D:\你的实例"
```

然后按需改 `~/.dsh-mc/config.json` 的端口。旧的 `cordis.patch.yml` 条目会被**更新**而不是重复追加
（更新前自动备份为 `.bak-<时间戳>`）。
