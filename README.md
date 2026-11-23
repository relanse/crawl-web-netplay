# Crawl 网页联机

这是 2–4 人网页联机所用的源码仓库。Unity 服务端运行对局并同步场景状态，WebGL 客户端渲染画面并发送玩家输入。Node.js 负责邀请、房间、游戏进程和结算。

| 路径 | 内容 |
| --- | --- |
| `server/online-server.mjs`、`server/room-session.mjs` | 大厅接口、身份、房间和对局生命周期 |
| `server/game-processes.mjs`、`server/online-progress.mjs` | 权威进程、玩家身份持久化、战报和排行榜 |
| `server/online/` | 大厅、游戏容器、帧率及音量设置 |
| `web-project/Assets/Scripts/Assembly-CSharp/Netplay/` | Unity 输入、快照、重连、权威对局和档案 |
| `web-project/Assets/Editor/` | 构建入口和 Unity 定向检查 |
| `server/test/` | Node.js 测试 |

## 服务端测试

需要 Node.js 22.13 或更高版本。

```sh
cd server
npm ci
npm test
```

## 与本地 Unity 工程一起开发

新克隆可以运行 Node.js 测试。Unity 构建依赖已有的本地移植工程，包括原版游戏逻辑、场景、资源和相关接线。构建游戏时，将本仓库的联机源码合入现有工程。Unity 版本为 `2022.3.62f3c1`，Mirror 版本与补丁记录见 [mirror-dependency.json](mirror-dependency.json)。

本地工程中的关键接线包括以下几处。

- `MenuJoin` 通过 `CrawlWebLobby` 绑定席位并启动游戏，原版输入入口通过 `CrawlRemoteInput` 读取远程操作。
- `SaveHelper` 在权威模式使用 `CrawlServerSaveStrategy`。`Profile` 和 `SystemPlayers` 在该模式按 `CrawlWebLobby.AuthorityPlayerId` 保存和查找档案。
- `BossEncounter` 在游戏结算和存档完成后调用 `CrawlAuthorityHost.RecordCompletion`，供 Node.js 登记正式战绩。

在 Windows 上使用现有工程生成权威服务端和配套的 WebGL 客户端。

```powershell
./run-netplay-build.ps1 -Mode server
./run-netplay-build.ps1 -Mode client
./start-network.ps1
```

前两条命令启动 Unity 后台构建，等各自的日志显示构建完成再继续。制作 Linux 服务端时，将第一条命令的 `server` 改为 `linux`。Unity Hub 需安装相应的目标平台模块。服务端与客户端构建须使用同一内容哈希。

玩家档案、排行榜数据库和房主存档保存在服务端对局目录的 `.progress` 中。部署时让数据目录与程序目录分开，并备份数据目录。访问密钥可由启动器本地生成，也可由 `CRAWL_ACCESS_KEY` 环境变量提供。

## 发布到广州

在原有 Windows 工程里提交改动，然后双击 `发布广州.cmd`。发布入口推送 `main` 到 GitHub，运行 Node.js 测试，从本机 Unity 工程构建 Linux 服务端和 WebGL 客户端，再经 SSH 发送同一份发布包。执行 `发布广州.cmd -Check` 可在服务器用独立数据验证发布包。

上传或切换失败时，`发布广州.cmd -Resume` 可重新发送当前提交已经构建好的发布包。

服务器先验证归档校验和、配对构建和大厅健康状态。发布时暂停新开局，等待在玩的对局结束，最多等约 15 分钟。切换期间会完整备份 `.progress`，校验 SQLite 数据库，再切换程序版本。启动检查失败时自动恢复到上一版程序和启动前的存档状态。

本机连接配置在 `deploy/publish.local.json`，结构见 `deploy/publish.example.json`。发布密钥保存在 Windows 用户的 `.ssh` 中，在广州服务器上只能调用发布命令。服务器的联机数据始终保存在 `/var/lib/crawl-online/matches`，发布备份在 `/var/backups/crawl-online`。

广州已安装 `deploy/activate.sh` 为 `/usr/local/sbin/crawl-publish`。`deploy/crawl-online-publish.conf` 是 `crawl-online.service` 的发布配置，安装在其 systemd 覆盖目录下。该配置让 Node.js 从 `/opt/crawl-online/current` 启动。
