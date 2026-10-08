# caoguoooo-workbench · 群晖安装

Demo 0.1.2，适用于 x86 黑群晖和 Docker Compose v2。项目、容器及镜像名称统一为 `caoguoooo-workbench`，页面品牌仍为 CYJ。

**不需要 .env，不用填写域名。配置都写在 compose.yaml，群晖本机端口为 8899。反向代理由你自行配置。**

## 首次安装

1. 从 [Release](https://github.com/caoguoooo/research-workbench/releases/tag/v0.1.2) 下载 `caoguoooo-workbench-demo-0.1.2.tar.gz` 和 `caoguoooo-workbench-demo-0.1.2-amd64.tar.gz`。
2. 解压源码，把镜像包放入包含 `compose.yaml` 的目录。在群晖 SSH 终端进入这个目录。
3. 执行：

   ```sh
   sh workbench.sh init
   ```

   自动导入镜像、准备资料、提示输入两次密码并启动。默认账号 `workspace`，密码至少 10 位；自定义账号可用 `sh workbench.sh init 你的账号名`。没有镜像包时，会尝试从源码构建。
4. DSM 反代目标使用 `HTTP → 127.0.0.1:8899`。通过你配置的 HTTPS 网址登录；应用无需预先知道域名，也不要求反代保留外部 Host。

镜像内程序端口为 3000，群晖端口是 8899；Compose 中的映射为 `127.0.0.1:8899:3000`。反代若运行在其他容器中，需要自行调整内部连接。演示资料包含 2 个公开项目及 16 个附件，不包含账号或 AI TOKEN。

## 平时使用

| 操作 | 命令 |
|---|---|
| 启动 | `sh workbench.sh start` |
| 停止 | `sh workbench.sh stop` |
| 查看状态 | `sh workbench.sh status` |
| 查看日志 | `sh workbench.sh logs` |
| 备份 | `sh workbench.sh backup` |

备份会短暂停止正在运行的应用，结束后恢复；原本停止的应用保持停止。备份含账号和 AI 配置，仅自己保存。

## 资料与更新

- `runtime/data/`：数据库、原图、账号和 AI 配置。
- `runtime/backups/`：按时间保存的备份。
- `demo-data/`：首次安装用的演示资料，已有资料不会被重复导入。

更新前备份，保留 `runtime/`，替换程序并导入新镜像，再执行 `sh workbench.sh start`。已有账号保留，运行中的应用需先停止再执行初始化。

**从 0.1.0 / 0.1.1 更新：先备份并在群晖停止旧容器 `research-workbench`，把新版程序放进原目录，保留原来的 runtime，导入新镜像后启动。新容器名为 caoguoooo-workbench，端口改为 8899。旧版 .env 不再用于配置；原来使用自定义资料路径的，在 Compose 的 volumes 中继续填写原路径。**

## 可选维护

所有修改都在 `compose.yaml` 中完成：

- 换资料目录：修改 `volumes` 中 `/data` 或 `/backups` 前面的宿主机路径。使用独立资料目录。
- 信任反代 IP：仅当反代可靠覆盖 X-Forwarded-For 且应用只由它访问时，将 `WORKBENCH_TRUST_PROXY` 改为 `'true'`。
- ARM 设备：将 `platform` 改为 `linux/arm64`，自行构建对应镜像；下载包为 x86 / amd64。

恢复备份：停止应用，将备份复制到新的独立目录，在 Compose 中将 `/data` 的挂载指向该目录，执行 `sh workbench.sh prepare` 和 `sh workbench.sh start`。原目录保留供回退。

重置密码：

```sh
sh workbench.sh stop
docker compose run --rm app npm run admin:init -- --username workspace --reset
sh workbench.sh start
```

健康接口为 `http://127.0.0.1:8899/healthz`，正常返回 `{"ok":true}`。正式登录通过 HTTPS 反代完成，密码、Cookie 和跨站请求校验仍然保留。

当前为单管理员 Demo：竞品档案可用，AI 支持文字对话；联网收集、自动归档及其他三个资料栏目尚未完成。

主页每日配图默认开启，由后端每天更新一次 Designboom 首页配图；关闭浏览器仍会运行。群晖需要能连接该网站，网络失败会保留上一次成功图片，首次尚未获取到图片时显示占位。可在 Compose 中将 WORKBENCH_HOME_VISUAL 改为 'false' 关闭。
