# 贡献指南（Contributing）

感谢贡献！本仓库的核心约束是：**`docs/ARCHITECTURE.md` 是唯一接口契约**。

## 开发环境

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node.js | 20+（推荐 22/24） | `packages/bridge` |
| JDK | 21/22 | `packages/mod`（可选，仅构建模组时需要） |
| PowerShell | Windows PowerShell 5.1 或 7+ | 安装脚本 |

```powershell
# 安装依赖
cd packages\bridge
npm install

# 单测（零 devDependencies）
npm test          # 等价于 node --test

# 手动跑 MCP server（默认 stdio）
node src\index.js doctor
node src\index.js probe
```

## 修改前

1. 先读 `docs/ARCHITECTURE.md`。接口（MCP 工具名/参数、HTTP 契约、配置字段、错误码）以它为准；
2. 要改接口：**先改 ARCHITECTURE.md**，再同步改 `bridge`、`mod`、文档与脚本；
3. 文档改动请同步更新 `docs/FAQ.md` / `docs/TROUBLESHOOTING.md` 中受影响的条目；
4. 不要提交真实密钥、网易账号、token、`~/.dsh-mc/config.json`、游戏日志。

## 代码风格

- 本项目没有 lint 强制，但请保持 2 空格缩进（Java 4 空格），遵循 `.editorconfig`；
- PowerShell 脚本必须同时兼容 **5.1 与 7+**：不要用 `??`、三元运算符、`-notin` 以外的 PS7
  专属语法；用 `[scriptblock]::Create((Get-Content -Raw <script>))` 至少做一次语法检查；
- 文档中的 YAML/JSON 片段必须可解析（缩进用空格）。

## 测试

```powershell
cd packages\bridge
npm test
```

- 单测放 `packages/bridge/test/*.test.js`，用 `node:test` + `node:assert`；
- 需要真实游戏的端到端脚本放 `packages/bridge/test/e2e/`，**不要**命名为 `*.test.js`，
  以免 CI 在无游戏环境时失败；
- CI（`.github/workflows/ci.yml`）在 Windows runner 上跑单测，并对 `packages/mod`
  的 Java 源码做「语法检查」（缺 NeoForge 依赖的报错会被容忍）。

## 提交 PR

- 一个 PR 聚焦一件事，说明动机与验证方式（命令、输出、截图均可）；
- 涉及模组的 PR，说明测试用的 MC/NeoForge 版本；
- 安全相关修复请不要在公开 issue 中贴敏感信息，见 `docs/SECURITY.md` 第 10 节。

## 许可证

提交代码即表示同意以仓库根目录的 MIT 许可证发布。
