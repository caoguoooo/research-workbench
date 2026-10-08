# 群晖 Demo 上线说明

反向代理由你配置，本包不修改路由器、DNS、证书或群晖反代规则。适用于 x86 黑群晖和 Docker Compose v2，应用仅映射 NAS 本机 `127.0.0.1:3000`。反代若在另一容器而非 DSM 宿主机运行，需调整内部网络连接。

## 放置和配置

将 `research-workbench-demo-0.1.0.tar.gz` 解压到独立目录，例如 `/volume1/docker/research-workbench/`，进入含 `compose.yaml` 的目录。主容器名称为 `research-workbench`，镜像为 `research-workbench:demo-0.1.0`。`demo-data` 包含当前竞品档案和附件，不包含账号或 TOKEN。运行资料放在 `runtime/data`，备份放在 `runtime/backups`。

```sh
cp .env.example .env
```

编辑 `.env`，将 PUBLIC_ORIGIN 改为实际完整 HTTPS 地址，不带 `/app` 路径。CYJ_HTTP_PORT 为 NAS 本机端口，默认3000，可避开端口冲突。默认 x86 架构；ARM 机器需改 CYJ_PLATFORM=linux/arm64 并重新构建。

## 导入或构建镜像

预构建 x86 镜像可用 Container Manager 导入，或执行：

```sh
gunzip -c research-workbench-demo-0.1.0-amd64.tar.gz | docker load
```

只有源码包时：

```sh
docker compose build app
```

## 初始化和启动

```sh
docker compose run --rm init-data
docker compose run --rm app npm run admin:init -- --username workspace
docker compose up -d app
docker compose ps
docker compose logs --tail 50 app
curl --fail http://127.0.0.1:3000/healthz
```

目录初始化工具使用独立的 runtime/data 和 runtime/backups，为应用 UID/GID 1000 设置权限。不要将这两个路径指向家庭共享文件夹或无关资料。已有 JSON 或数据库不会重复导入样例。

账号初始化需要交互终端，提示输入两次密码，以星号遮蔽，至少10位；没有默认密码，正式版本不开放网页创建管理员。真实密码不要写进聊天或命令参数。健康接口应返回 `{"ok":true}`，端口按配置调整。首次启动会将 JSON 迁入 SQLite，原图不移动，原 ID 保留。

## 反代与验收

你的反代目标为 NAS 本机上述端口，外部访问需为 HTTPS，与 PUBLIC_ORIGIN 完全一致。正式 Cookie 具有 Secure 属性，HTTP 页面不能完成正式登录。后端按固定域名验证写入请求，不依赖反代是否改写 Host。不要直接从路由器把3000端口映射到公网。

仅当反代可靠覆盖 X-Forwarded-For 且后端只由该反代访问时，设置 CYJ_TRUST_PROXY=true，用于区分登录限流来源；它不会配置反代。

用域名登录后检查成都、重庆分组和原图；上传测试图片、点击放大；新建临时档案、删除、从回收站恢复；重启后重新登录，确认资料保留。AI 地址及 TOKEN 在设置重新填写，模型在对话窗口选择。实际 AI 服务仍需验证是否兼容。

## 备份和恢复

每次更新前备份，可通过群晖任务计划定期执行。先停止应用以避免上传或配置修改期间不一致：

```sh
docker compose stop app
docker compose run --rm app npm run backup
docker compose up -d app
```

备份含 SQLite、原图、账号和 AI 配置，属于私密文件，不可分享或当公开安装包。恢复时停止应用，将备份内容复制到新的独立资料目录，修改 CYJ_DATA_PATH 指向新目录，运行 init-data 修复权限后启动。检查图片和记录，旧目录保留供回退。正式版本以 workbench.sqlite 为准，旧 JSON 只是迁移来源。

升级保留 .env 和 runtime 目录，更新代码或导入新镜像后重新创建 app。不要复制开发电脑的账号、TOKEN 或空密码设置。docker compose down 不删除挂载资料，勿删除 runtime/data。

需重置密码时在服务器本机执行：

```sh
docker compose stop app
docker compose run --rm app npm run admin:init -- --username workspace --reset
docker compose up -d app
```

当前为单管理员、单实例 Demo。AI 仅文字对话，未接入联网检索、图片收集、一键建档。其他三个资料分类仍是入口占位。

参考：[Compose 部署](https://docs.docker.com/compose/how-tos/production/)、[数据持久化](https://docs.docker.com/engine/storage/volumes/)。
