# guoooo_workspace · 1.0.0

房地产研究资料工作台，支持本机运行及 Docker / 群晖部署。

## 功能

- 竞品档案：按城市、区位组织项目，集中管理概况、总规划、效果图、户型图、研究正文及附件；支持图片放大，效果图每项目最多 6 张。
- 周边地图：高德地图定位、楼盘检索与四类配套核对，支持批量更新并保留人工资料；密钥在设置中配置和检测。
- 素材库：规划彩总、立面效果、大门、示范区景观分类，支持筛选、多图上传、原图下载及回收站；可通过服务端代理预览 Pinterest 公开画板并选择归档。
- 账号与权限：注册须管理员审核，普通用户只读；管理员维护资料、用户和系统配置。支持个人资料、修改密码及记住登录。
- 支持明暗模式，首页配图每日更新，也可由管理员手动刷新。

## 安装及升级

从 [Releases](https://github.com/caoguoooo/research-workbench/releases) 下载同版本程序包与 amd64 镜像包。程序包不含业务数据。

- 首次安装：`sh workbench.sh init`。
- 已有安装：从新版目录执行 `sh workbench.sh upgrade 现有安装目录`，先备份，再切换镜像，保留原配置和数据挂载。
- 回退：在原安装目录执行 `sh workbench.sh rollback`，仅支持兼容的数据结构，不会自动还原数据库。

升级前核实 NAS 实际挂载及备份空间；不要用新目录的空数据替换原资料。完整步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 开发及发布

需要 Node.js ≥24，首次开发使用 `npm ci` 安装依赖。本机预览使用独立临时数据目录：

```sh
preview_dir="$(mktemp -d /tmp/workbench-preview.XXXXXX)"
NODE_ENV=development HOST=127.0.0.1 PORT=3000 PUBLIC_ORIGIN='' WORKBENCH_DATA_DIR="$preview_dir" WORKBENCH_STORAGE=json WORKBENCH_HOME_VISUAL=false WORKBENCH_TRUST_PROXY=false npm run dev
```

访问 `http://127.0.0.1:3000`；这是空密码预览，不用于生产。勿对同一资料目录混用 JSON 与 SQLite。

测试与修改约束见 [AGENTS.md](AGENTS.md)，数据与 API 见 [BACKEND.md](BACKEND.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

`npm run package:release` 生成仅含程序的发布包。发布前同步 [package.json](package.json)、[package-lock.json](package-lock.json)、[compose.yaml](compose.yaml) 和更新记录的版本；推送 `vX.Y.Z` 标签后，CI 测试并验收 amd64 镜像，再发布离线包与 GHCR 镜像。已发布版本不覆盖。
