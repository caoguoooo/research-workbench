# 群晖安装与版本维护

1.0.0，适用于 x86 / amd64 群晖和 Docker Compose v2。只需一个应用容器，不需要额外数据库服务。配置在 compose.yaml 中，不需要 .env；反代自行设置。

## 首次安装

1. 从同一 [Release](https://github.com/caoguoooo/research-workbench/releases) 下载：
   - caoguoooo-workbench-1.0.0.tar.gz（程序）
   - caoguoooo-workbench-1.0.0-amd64.tar.gz（离线镜像）
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

## 0.3.0 升级说明

本版移除工作台 Hermes 接口及执行服务，不影响档案中的研究正文。升级前停止旧工作台 worker，保护性备份 runtime 下的 Hermes 队列、挂载配置和密钥；升级工具不再自动加载 Hermes overlay。确认新版健康后，将旧 worker 容器移除、相关配置移到仅管理员可读的停用备份目录。独立部署的 Hermes-Agent 不属于工作台服务，不随本次升级卸载。

地图仅使用高德底图。管理员需在设置保存 Web 端（JS API）Key 和匹配的 securityJsCode；批量更新周边还需 Web 服务 Key。未配置 JS API 时仍可查看已保存位置和配套清单，但不显示其他厂商底图。地图资料保存在业务数据中，不随程序发布包分发。
