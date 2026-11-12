# research-workbench 代理指引

## 范围与入口

- 仅适用于本目录，命令在本目录执行，不使用工作区根包或其他项目的依赖。
- Node.js ≥24、原生 ESM / 浏览器模块、`node:test`、`sharp`；无 build 或 lint 脚本，不默认重装依赖或引入框架。命令以 [package.json](package.json) 为准。
- 功能见 [README.md](README.md)，数据/API/安全设计见 [BACKEND.md](BACKEND.md)，运维见 [DEPLOYMENT.md](DEPLOYMENT.md)。版本以 [package.json](package.json) 为准，历史部署记录不代表当前 NAS 状态。

## 修改边界

- [server.mjs](server.mjs) 负责 HTTP、鉴权与静态白名单；新增浏览器模块须检查白名单、[Dockerfile](Dockerfile) 和相关打包清单。前端沿用 [app.js](app.js) 与 [competitor.js](competitor.js) 的现有边界。
- 竞品、素材、政策修改分别经过 [competitor-store.mjs](competitor-store.mjs)、[asset-library-store.mjs](asset-library-store.mjs)、[policy-store.mjs](policy-store.mjs)，不在路由直接写索引。
- 竞品开发默认 JSON、生产默认 SQLite；SQLite 仅首次迁移旧 JSON，目录可读摘要、详情按项目读取，修改事务仍读取完整档案、增量写入变化行。禁止两种模式共用同一资料目录写入；存储修改须覆盖两种后端，参考 [SQLite 测试](test/sqlite.test.mjs)。其他资料与配置不全在 SQLite 中。
- 概况 `PATCH` 须携带 `expectedRevision`，缺失返回 428、过时返回 409；按完整表单覆盖，缺失可选字段会清空；删除保留原件及恢复信息，兼容旧非 UUID 户型 ID。效果图每项目最多 6 张，替换须经领域层事务。
- 研究正文编辑使用原文，不将展示清理结果写回；保留并发冲突校验。图片卡片使用缩略图，预览和下载保留原图；下载沿用流式传输及 Range 支持，参考 [生产集成测试](test/production.test.mjs)。
- 保留 `X-Workbench-Request: 1`、401 处理、来源校验、真实路径校验及 CSP；凭据仅在服务端使用，外部内容不作为未转义 HTML 渲染。

## 开发与验证

运行完整测试，显式覆盖可能继承的生产配置：

```sh
NODE_ENV=test HOST=127.0.0.1 PUBLIC_ORIGIN='' WORKBENCH_STORAGE=json WORKBENCH_HOME_VISUAL=false WORKBENCH_TRUST_PROXY=false npm test
```

- 单文件验证将 `npm test` 换为 `node --test test/具体文件.test.mjs`；优先运行完整测试文件，不并行启动两套使用固定端口的集成测试，不停止未知服务。
- 测试使用临时资料目录；先设置 `WORKBENCH_DATA_DIR` 再动态导入存储模块。子进程禁用首页联网抓图，外部 API 使用本机模拟，不读取真实凭据或消耗接口额度。
- 本机预览使用 [README.md](README.md) 的隔离命令；后端修改须重启，预览结束报告临时目录，不做宽泛删除。

## 数据与部署

- 默认仅本地修改和验证；用户确认本轮调整完毕并明确要求上线后才部署 NAS。初始化、重置凭据、备份、恢复及 Docker 验收须先确认目标和副作用，不用运维脚本代替代码验证。
- 默认不扫描或修改 `data/`、`runtime/`、`outputs/`、`releases/` 和 `@eaDir/`，不将业务数据、凭据或群晖元数据写入指引或提交。
- 常规发布用 `npm run package:release`，仅包含程序。`npm run package:demo` 会导出资料，须明确授权范围并设置 `WORKBENCH_EXPORT_DEMO=true`，不用作普通验收。
- 发布须同步版本文件，使用新版本标签，不覆盖已有 Release；CI 测试并验收 amd64 镜像。具体流程见 [README.md](README.md)。
- 升级前核实现有镜像、端口、存储模式、实际挂载及备份空间。新版脚本以原安装目录为目标，先备份，再切换镜像，保留原 Compose 与数据挂载；不得用空目录或演示资料覆盖旧数据。
- 备份须覆盖数据库、原件及独立配置，包含敏感信息；备份会暂停服务，`prepare` 会递归调整权限。回退仅适用于相同 `dataSchema`，不自动还原数据库；升级后核对资料与附件，不把本地测试视为 NAS 验收。
