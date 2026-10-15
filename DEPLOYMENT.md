# 群晖安装与版本维护

0.2.1，适用于 x86 / amd64 群晖和 Docker Compose v2。只需一个应用容器，不需要额外数据库服务。配置在 compose.yaml 中，不需要 .env；反代自行设置。

## 首次安装

1. 从同一 [Release](https://github.com/caoguoooo/research-workbench/releases) 下载：
   - caoguoooo-workbench-0.2.1.tar.gz（程序）
   - caoguoooo-workbench-0.2.1-amd64.tar.gz（离线镜像）
   - SHA256SUMS（校验文件）
2. 在下载目录执行 `sha256sum -c SHA256SUMS`，解压程序包，把镜像包移到解压后 workbench.sh 旁边。
3. 如有需要先调整 compose.yaml 中的端口和资料挂载。新安装默认 127.0.0.1:8899，容器内部端口 3000；已有安装的升级会保留现场配置，不替换端口。
4. 进入程序目录，执行 `sh workbench.sh init`，按提示为 admin 设置至少 8 位密码。可用 `sh workbench.sh init 自定义账号` 指定其他用户名。
5. 通过自己配置的 HTTPS 反代访问。正式登录 Cookie 使用 Secure，直接用 HTTP 登录不适用于正式环境。

全新安装不导入竞品资料。已有账号、档案、图片不会被初始化覆盖。

## 从旧版升级

新版程序解压到一个新目录，保留旧安装目录及其 runtime。将同版镜像包放在新版 workbench.sh 旁边，然后执行：

```sh
sh /新版目录/workbench.sh upgrade /原安装目录
```

升级工具会依次：检查并导入新镜像；停止旧服务；使用原来的资料挂载生成完整备份；写入版本选择配置；启动新版并检查健康状态。原 compose.yaml 不修改，端口、反代、环境配置和资料目录保留。更新完成后将新版 workbench.sh 复制到原目录，后续启动使用此脚本。

版本选择记录在原目录 runtime/release.yaml，只覆盖 app 的镜像，其余配置继续读取原 compose.yaml。网页程序运行于镜像内，升级不依赖覆盖宿主机的旧源码。直接运行 docker compose 时需带上该版本配置，日常建议统一使用 workbench.sh。

现有管理员用户名及密码原样保留；新安装默认 admin。如需修改旧账号名称，应单独处理，不通过重置密码来改名。

## 回退

在原安装目录执行：

```sh
sh workbench.sh rollback
```

回退前再次备份，切回上一镜像，继续使用现有资料。升级健康检查失败时也会尝试自动切回；请用 `sh workbench.sh status` 与日志确认恢复结果。

仅支持相同 dataSchema 的程序回退。本版 dataSchema 为 1，新增用户资料采用独立文件，业务 SQLite 表结构兼容。未来如版本说明要求升级数据格式，应按该版恢复说明使用对应备份；不要让旧程序直接写入不兼容资料。不要清理仍需回退的旧镜像。

## 日常操作

| 操作 | 命令 |
|---|---|
| 查看版本 | `sh workbench.sh version` |
| 启动 / 停止 | `sh workbench.sh start` / `sh workbench.sh stop` |
| 状态 / 日志 | `sh workbench.sh status` / `sh workbench.sh logs` |
| 备份 | `sh workbench.sh backup` |
| 回退上一版本 | `sh workbench.sh rollback` |

备份短暂停止应用后恢复运行。备份包含账号、API 配置、档案、头像和历史对话，仅自己保存。普通登录会话不保留到服务重启；勾选记住登录可保持 7 天。修改密码、停用或删除账号会撤销该账号的登录。

## 连接已有 Hermes

Hermes 需启用官方 API，并配置可用模型和联网检索。执行服务调用 `/v1/runs` 与持久幂等接口；例如本机 API 为 `http://127.0.0.1:8642`，Dashboard 9119 不用于提交任务。

在现有工作台安装目录准备 `runtime/hermes-outbox`，属主 UID/GID 1000、权限 700；将 integration/compose.hermes-app.yaml 复制为 runtime/hermes-app.yaml。新版 workbench.sh 会自动读取这个额外配置，保留原 compose.yaml 和版本选择记录。

把 integration/compose.hermes-worker.yaml 复制到 runtime/hermes-worker.yaml，按实际情况修改 WORKBENCH_URL、HERMES_URL 和镜像版本。模板适用于同一 Linux NAS：执行服务使用 host 网络访问两个本机接口，不新增对外端口。将 Hermes API Key 安全写入 runtime/hermes-key，属主 1000:1000、权限 600；不把密钥写入仓库、聊天或模型提示。所有非敏感配置在 Compose 中，不需要 .env。

执行 `sh workbench.sh start` 重新创建应用挂载，再执行 `docker compose --project-directory runtime -f runtime/hermes-worker.yaml up -d` 启动执行服务。研究任务列表显示“Hermes 已连接”后，新建任务会自动执行。已有任务可点击“交给 Hermes”；执行失败可重试。撤销任务会撤销凭据，并由执行服务停止相关 Hermes 运行。

服务重启会继续轮询已保存的 run_id，避免再次创建同一运行。一次研究最多等待 15 分钟，超时或输出无有效 JSON / 来源时标记失败，不自动批准。队列只保留待执行的凭据，完成后移除；状态不包含密钥。不要运行多个执行服务消费同一队列。

档案备份包含研究任务及审核结果，不包含 runtime/hermes-key 和待执行队列。恢复到新安装后重新配置执行服务，并对未完成任务重试。工作台升级保留 runtime/hermes-app.yaml；执行服务单独固定版本，后续更新其镜像标签后重新创建即可。

## 数据和恢复

默认资料目录 runtime/data，备份目录 runtime/backups，也可以使用原 compose.yaml 中的自定义挂载。程序发布包不包含这些目录。

恢复时先停止应用，把选定备份复制到一个新的独立目录，修改 compose.yaml 中 /data 对应的宿主机路径，再运行 `sh workbench.sh prepare` 和 `sh workbench.sh start`。保留原目录。恢复时重新登录；不要复制旧 remembered-sessions.json。

忘记管理员密码时，在停止服务后使用当前镜像运行 scripts/admin.mjs；若存在 runtime/release.yaml，执行 docker compose 命令时同时带上 `-f compose.yaml -f runtime/release.yaml`。该操作仅重置登录凭据，不是普通升级步骤。

## 发布新版本

维护 main 的源码，实际资料留在 NAS。先修改并测试，更新 package.json、package-lock.json、compose.yaml 和 CHANGELOG.md 的版本，然后推送相同版本标签，例如 v0.2.1。

CI 自动执行完整测试。Release 流程重新测试、构建 amd64 镜像、验收容器与升级回退，再生成程序包、离线镜像和 SHA256SUMS，并发布私有 GHCR 镜像。NAS 可继续使用离线镜像，不需要配置 GitHub Token。没有自动部署到 NAS 的步骤。

GitHub Actions 权限由仓库 GITHUB_TOKEN 提供。仓库需允许 Actions 及写入 Releases/Packages；若账户额度或权限不足，发布会失败并保留日志，不能把未完成的流程视为发布成功。
