# 群晖安装 · Demo 0.1.1

适用于 x86 黑群晖、Docker Compose v2。容器名为 `research-workbench`，反向代理由你自己配置。

## 首次安装

1. 从 [Release](https://github.com/caoguoooo/research-workbench/releases/tag/v0.1.1) 下载源码包和 amd64 镜像包。解压源码包，把镜像包放进包含 `compose.yaml` 的目录。
2. 在群晖 SSH 终端进入该目录，复制配置文件：

   ```sh
   cp .env.example .env
   ```

3. 编辑 `.env`，只需要看两项：

   ```ini
   PUBLIC_ORIGIN=https://你的实际域名
   CYJ_HTTP_PORT=3000
   ```

   域名使用完整 HTTPS 地址，不带 `/app`。端口被占用时更换端口。

4. 执行一条安装命令：

   ```sh
   sh workbench.sh init
   ```

   它会导入同目录的镜像、准备资料、让你输入两次密码，然后启动。默认账号是 `workspace`；密码至少 10 位。想改账号名，可使用 `sh workbench.sh init 你的账号名`。已有账号和资料保留；已在运行的应用需先停止再初始化。没有镜像包时，会尝试从源码构建。

5. 将 DSM 反代目标设置为 `HTTP → 127.0.0.1:3000`，端口与配置一致。通过上述 HTTPS 域名登录即可。

源码包带有 2 个公开项目及 16 个附件，不包含账号或 AI TOKEN。AI 接口在登录后的设置中重新填写。若反代运行在另一个容器中，需要单独调整内部连接方式。

## 平时使用

| 操作 | 命令 |
|---|---|
| 启动 | `sh workbench.sh start` |
| 停止 | `sh workbench.sh stop` |
| 查看状态 | `sh workbench.sh status` |
| 查看日志 | `sh workbench.sh logs` |
| 备份 | `sh workbench.sh backup` |

备份时脚本会短暂停止正在运行的应用，结束后恢复运行；原本停止的应用保持停止。备份含账号和 AI 配置，仅自己保存。

## 资料存放

- `runtime/data/`：数据库、原图、账号和 AI 配置。更新时保留这个目录。
- `runtime/backups/`：按时间保存的备份。
- `demo-data/`：首次安装用的演示资料。

更新前执行备份，保留 `.env` 和 `runtime/`，替换程序及导入新镜像后执行 `sh workbench.sh start`。升级时无需重新设置账号，也不要用安装包覆盖运行资料。

## 可选维护

以下配置有默认值，一般不需要填写；旧版 `.env` 中的这些配置仍然有效：

- `CYJ_DATA_PATH`、`CYJ_BACKUP_PATH`：自定义资料和备份路径，默认分别为 `./runtime/data`、`./runtime/backups`。使用独立目录，勿指向家庭共享文件夹。
- `CYJ_TRUST_PROXY=true`：仅在反代可靠覆盖 X-Forwarded-For 且应用只由它访问时使用，默认关闭。
- `CYJ_PLATFORM=linux/arm64`：ARM 设备使用，并自行构建对应镜像；下载的 amd64 镜像适用于 x86。

恢复备份：先停止，把备份复制到新的独立资料目录，设置 `CYJ_DATA_PATH` 指向新目录，再执行 `sh workbench.sh prepare` 修复权限和 `sh workbench.sh start`。原目录保留供回退。

重置账号密码：

```sh
sh workbench.sh stop
docker compose run --rm app npm run admin:init -- --username workspace --reset
sh workbench.sh start
```

应用只映射 NAS 本机端口。正式登录需要 HTTPS，访问域名与 PUBLIC_ORIGIN 一致。健康接口为 `http://127.0.0.1:3000/healthz`，正常返回 `{"ok":true}`。

当前为单管理员 Demo：竞品档案可用，AI 支持文字对话；联网收集、自动归档及其他三个资料栏目尚未完成。
