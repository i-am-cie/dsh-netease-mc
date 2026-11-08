# 安全与合规

> 本项目让 **AI 直接操作你的游戏世界**。请先读完本文再运行安装脚本。
> 一句话原则：**能不给的权限就不给，能只在本机就不出网，能不装模组就先不装。**

## 1. 威胁模型

| 资产 | 威胁 | 缓解 |
|---|---|---|
| 网易账号 / 游戏角色 | 第三方模组触发风控、封号 | 默认通道 A（零侵入）；通道 B 需自行评估，建议测试号 |
| DeepSeek API Key | 被写入仓库/配置/日志后泄露 | 只从环境变量读取；DSH 配置不落密钥 |
| 本机游戏世界存档 | LLM 执行破坏性操作（拆家、放岩浆、杀村民） | `policy` 权限闸门、`--dry-run`、世界备份 |
| 游戏内 HTTP 接口（通道 B） | 本机其他程序/局域网访问 | 只监听 `127.0.0.1`，强制 Bearer token |
| 聊天/日志内容 | 泄露隐私信息 | 日志本地保存、分享前脱敏 |
| 本机其他服务 | 端口扫描、误连 | 端口固定/可配置，不暴露公网 |

**不在防护范围内的**：已经拿到你操作系统的攻击者、你自己主动把 token/密码贴到聊天里、
把 `cordis.patch.yml` 或 `config.json` 提交到公开仓库。

## 2. 账号与凭据

### 2.1 绝对不要提交的东西

- 网易账号/密码、短信验证码、登录 cookie；
- GitHub 账号密码、PAT/token、SSH 私钥；
- DeepSeek API Key（`sk-...`）；
- 通道 B 的 `token`（在 `<gameDir>/config/netease_mc_link.json`）；
- 包含上述内容的日志、截图、录屏。

`.gitignore` 已排除 `dsh-mc.config.json`、`.env*`、`**/config/netease_mc_link.json`、
`*.log` 等。**但不要依赖 .gitignore**：提交前用 `git diff --cached` 自己看一眼。

### 2.2 配置文件的正确用法

- `~/.dsh-mc/config.json` **只放非敏感配置**（host/port/mode/policy）。
- `DEEPSEEK_API_KEY` 只放在**环境变量**里。bridge 通过 `agent.apiKeyEnv` 指定变量名，
  进程启动时读取；不要写进 JSON、YAML 或脚本。
- 通道 B 的 token **只从环境变量 `DSH_MC_TOKEN` 读取**；配置文件里的 `mod.token` 会被忽略
  （并产生告警），这是为了防止 token 被误提交到仓库。
- DSH 启动 stdio MCP 时**会清洗**名字匹配 `KEY|PASSWORD|SECRET|TOKEN` 的环境变量，
  所以 `cordis.patch.yml` 的 `env:` 里只显式给 `DSH_MC_CONFIG`，其他密钥让它从系统环境
  继承；通道 B 若因清洗拿不到 token，再在本地 `cordis.patch.yml` 的 `env:` 里显式加
  `DSH_MC_TOKEN`——**该文件不要提交**，且不要把密钥写进仓库里的任何文件。

### 2.3 Token 轮换

通道 B 的 token 泄露/怀疑泄露时：

1. 关闭游戏（模组进程退出后端口关闭）；
2. 删除 `<gameDir>/config/netease_mc_link.json`；
3. 重启游戏，模组会生成新 token 并打印到日志；
4. 更新系统环境变量 `DSH_MC_TOKEN`（或本地 `cordis.patch.yml` 里显式注入的值）；
5. 重启 DSH，让 MCP 子进程重新读取环境变量。

DeepSeek API Key 泄露时：立即到平台吊销并重建，更新环境变量，重启 DSH。
GitHub 凭据泄露时：吊销 token / 改密码 / 清 SSH key，检查仓库提交历史。

## 3. 网易客户端与第三方模组的风险

- 本项目**默认不安装任何游戏内模组**（通道 A 用 mineflayer 作为普通玩家连入）。
- 通道 B 需要把自编译的 NeoForge 模组放进 `<gameDir>/mods/`。这属于**修改游戏客户端**：
  - 可能违反网易《我的世界》用户协议/反作弊策略；
  - 可能导致模组不加载、游戏崩溃，甚至账号被风控/封禁；
  - 网易客户端更新后模组可能失效。
- 建议：**先只跑通道 A**；确需通道 B 时，使用测试账号与可恢复的存档，并做好备份。
- 不要从不明来源下载"增强模组/外挂"；本项目仓库只包含自己构建的模组源码与 jar。

## 4. 网络暴露面

- 通道 B 模组**只监听 `127.0.0.1:38210`**（默认）。不要改成 `0.0.0.0`，否则同局域网
  设备可以访问，必须同时保证 token 强度。
- 通道 A 连接 `127.0.0.1:<LAN 端口>`。Minecraft 的"对局域网开放"本身会向局域网广播
  一个随机端口，**只在可信网络（家庭/个人热点）开 LAN**；在公共 Wi-Fi 下不要开。
- 不需要在 Windows 防火墙里放行这些端口；如果杀软/防火墙拦截了本机回环（少见），
  只对 `node.exe` 放行回环，不要对公网放行。
- 检查监听情况：`Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 38210`。

## 5. 最小权限 policy

bridge 的执行入口统一过权限闸门（`config.policy`），默认值适合"单机创造/生存自己玩"。
建议按场景收紧：

| 场景 | 建议配置 |
|---|---|
| 只看状态（只读） | `allowRead:true`，其余全 `false` |
| 单机建造 | `allowRead/allowMove/allowWorldWrite:true`，`allowCommands/allowChat/allowAttack:false` |
| 管理自己的测试服 | 可开 `allowCommands`，保留 `allowAttack:false` |
| 公共服务器 | **不要用** `allowWorldWrite/allowAttack/allowChat`，遵守服务器规则 |

被禁止的操作会返回结构化错误（`code: "policy_denied"` 或 `"unsupported_in_bot_mode"`），
**不会静默降级**。不要为了"方便"直接全开。

## 6. 日志脱敏

- bridge 默认只记录 `{ts, tool, args, ok, ms}`。聊天内容、坐标等可能出现在日志里，
  日志**只保存在本机**。
- 分享日志到 issue 前：删掉 token、API Key、聊天原文、服务器地址、存档路径中的用户名。
- 不要在日志里打印完整请求头；通道 B 的鉴权头只做校验，不落盘。
- 游戏日志 `logs/latest.log` 可能含账号名/服务器地址，分享前同样处理。

## 7. LLM 破坏性操作的缓解

LLM 会"很努力地完成任务"，包括你其实不想要的任务。请始终：

1. **先 dry-run**：`node packages/bridge/src/index.js agent --goal "..." --dry-run`
   只打印计划不执行；确认计划合理后再去掉 `--dry-run`。
2. **先只读**：第一次连接时把 `policy.allowWorldWrite/allowCommands/allowAttack` 设为 `false`，
   看 `mc_state` / `mc_inventory` / `mc_nearby_blocks` 是否符合预期。
3. **备份世界**：操作前复制存档目录（默认 `<gameDir>/saves/<世界名>`）到安全位置；
   创造模式测试建议新建超平坦世界。
4. **限制步数**：`agent.maxSteps` 默认 40，不要设得过大；给模型的任务描述要具体
   （"在我面前用橡木木板搭一个 5×5 的小屋" 优于 "帮我建个房子"）。
5. **不要交给 AI 不可逆操作**：删除存档、在公共服刷物品、PVP 攻击其他玩家。
6. **人在回路**：重要世界操作前在对话里确认；发现异常立刻 `mc_move {"stop":true}` 或关游戏。

## 8. 依赖与供应链

- bridge 唯一运行时依赖是 `mineflayer`（及其传递依赖），安装时优先用 `npm ci` 锁定版本。
- 模组只从本仓库源码构建，不下载第三方 jar。
- 定期 `npm audit` 检查依赖漏洞；升级 mineflayer 后跑 `node --test`。

## 9. 合规声明

- 本项目与网易、Mojang、Microsoft 无隶属关系，未获其背书。
- 使用本项目需遵守《我的世界》EULA、网易用户协议与所在服务器规则。
- 代码以 MIT 许可证发布（见仓库根目录 `LICENSE`）；游戏资源与商标归各自权利人所有。
- 本项目**不做**：破解、注入进程内存、绕过登录/反作弊、自动注册账号、盗版分发。

## 10. 报告安全问题

请通过 GitHub 仓库的 **Security Advisory（私密漏洞报告）** 提交，不要在公开 issue 里贴
token、账号或可复现的隐私数据。维护者会在确认后修复并致谢。
