程序包不包含竞品档案、原图、账号、头像、聊天记录或 API 配置。

首次安装：下载程序包及 amd64 镜像包，将镜像包放在解压后 workbench.sh 所在目录，执行 `sh workbench.sh init`。

已有群晖安装：保留原安装目录，在新版目录执行 `sh workbench.sh upgrade 原安装目录`。升级会先备份，再切换镜像，保留原 compose.yaml、端口、挂载及账号。完成后可在原目录执行 `sh workbench.sh rollback` 回退上一个兼容版本。

详细步骤请看同版本 DEPLOYMENT.md。此版本不会自动部署到 NAS。
