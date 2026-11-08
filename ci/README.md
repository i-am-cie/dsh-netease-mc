# GitHub Actions 工作流（待启用）

`github-actions-ci.yml` 是 CI 工作流，但因为当前用于首次推送的 GitHub OAuth App token
只有 `gist` / `read:org` / `repo` scope，GitHub 拒绝创建 `.github/workflows/` 下的文件
（`refusing to allow an OAuth App to create or update workflow ... without 'workflow' scope`）。

启用方式（二选一）：

1. 授予 `workflow` scope 后推送（推荐）：

   ```powershell
   gh auth refresh -s workflow
   New-Item -ItemType Directory -Force .github\workflows | Out-Null
   Move-Item ci\github-actions-ci.yml .github\workflows\ci.yml -Force
   git add .github\workflows\ci.yml ci\github-actions-ci.yml
   git commit -m "ci: enable GitHub Actions workflow"
   git push
   ```

2. 在 GitHub 网页端手动新建 `.github/workflows/ci.yml`，内容复制自本目录的
   `github-actions-ci.yml`。

工作流内容：

- `bridge`：Windows runner + Node 20，`node --test` 跑 bridge 单元测试（不依赖游戏）。
- `mod`：语法检查（尽力而为），在没有本地 NeoForge 依赖的 runner 上不会因此失败。
