# guoooo_workspace · 0.2.3

房地产研究资料工作台，可在本机预览，通过 Docker 部署到群晖。浏览器标签显示 guoooo_workspace，入口保留 CYJ 标志。

## 使用

- 竞品档案：城市 → 区位 → 项目，区位按项目数量降序；概况、总规划、效果图、户型图、研究正文、周边地图及附件统一浏览，图片可放大。
- 管理员维护档案、审核研究任务、管理用户和配置地图。普通用户只读，项目资料、政策规范、素材库显示“建设中，敬请期待...”。
- 注册账号须管理员审核，密码至少 8 位；支持记住登录及修改密码。现有管理员账号保留，首次安装默认 admin。
- 用户管理支持角色、停用、删除、重设密码、昵称与头像。右上角优先显示昵称；用户可自行编辑个人资料。
- 支持明暗模式；配置高德 JS API Key 与配套安全密钥后显示高德地图、检索楼盘和周边配套；支持保存并检测，结果人工确认后保存。原 Web 服务 Key 保留为备选。
- 首页每日更新 Designboom 配图，支持管理员手动刷新；竞品目录与详情统一滚动。
- 周边地图统一高德，支持按项目批量核对位置与四类周边配套；效果图最多 6 张，可修改或删除。
- 已移除 Hermes 任务入口、代理接口和执行服务；已保存的档案研究正文及历史配置保留。

## 安装及升级

从 [Releases](https://github.com/caoguoooo/research-workbench/releases) 下载同版本程序包与 amd64 镜像包。常规包仅包含程序，实际资料与账号留在 NAS。

首次安装运行 `sh workbench.sh init`；已有安装从新版目录运行 `sh workbench.sh upgrade 现有安装目录`。升级先备份，保留原端口和资料挂载。原目录执行 `sh workbench.sh rollback` 可切回上一兼容镜像。步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 开发及发布

需要 Node.js 24。`npm ci` 安装依赖，`npm run dev` 启动仅本机可用的空密码预览。默认使用本目录 data，隔离测试请指定 WORKBENCH_DATA_DIR；勿对同一资料目录混用 JSON 与 SQLite。

`npm test` 完整测试；`npm run package:release` 生成不含业务数据的程序包。数据结构与权限见 [BACKEND.md](BACKEND.md)。

GitHub 对 main 和 PR 自动测试。发布前同步 package.json、package-lock.json、compose.yaml 和 CHANGELOG.md 版本，推送对应 vX.Y.Z 标签；发布流程通过测试和容器验收后生成离线镜像、校验文件和私有 GHCR 镜像。可在 Actions 手动重试尚未成功发布的已有标签；已发布版本不覆盖。
