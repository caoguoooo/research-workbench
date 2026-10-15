# research-workbench 代理指引

## 范围与入口

- 本指引仅适用于本目录；命令从 `/workspace/research-workbench` 执行，不使用工作区根包或其他项目的依赖与脚本。
- 使用 Node.js ≥24、原生 ESM、原生浏览器模块和 `node:test`；图像处理依赖 `sharp`，没有 build 或 lint 脚本，不默认运行 `npm ci` 或引入框架。命令以 [package.json](package.json) 为准。
- 功能入口见 [README.md](README.md)，数据/API/安全设计见 [BACKEND.md](BACKEND.md)，运维见 [DEPLOYMENT.md](DEPLOYMENT.md)。旧文档的“聊天仅内存保存”“尚未联网/归档”已落后于实现；功能判断以代码与测试为准。
- [NAS 部署记录](NAS-DEPLOYMENT-2026-10-09.md) 是历史现场信息，不代表当前在线版本或本次验收结果。

## 修改边界

- [server.mjs](server.mjs) 管 HTTP、鉴权及显式静态资源白名单；新增浏览器模块时检查该白名单，以及 [Dockerfile](Dockerfile) 和 [打包脚本](scripts/package-demo.mjs) 的复制清单。
- 前端沿用 [app.js](app.js) 的导航/设置、[competitor.js](competitor.js) 的档案、[research-tasks.js](research-tasks.js) 的研究任务边界；旧聊天和 AI 设置界面已移除，历史后端与数据仍保留。
- 竞品修改经 [competitor-store.mjs](competitor-store.mjs) 完成，不在路由直接写索引。开发默认 JSON、生产默认 SQLite；后者只迁移一次旧 JSON，禁止两种模式共用同一资料目录进行写入。修改领域存储须覆盖两种后端，参考 [SQLite 测试](test/sqlite.test.mjs)。
- 不假设所有持久化数据均在 SQLite：AI 设置、聊天历史、记住登录分别由各自存储模块管理；位置与语义见 [后端设计](BACKEND.md)。
- 概况 `PATCH` 当前按完整表单覆盖字段，缺失的可选字段会清空；调用前核对存储实现。删除是可恢复的软删除，保留附件与关联；兼容旧 `floorplan-01` 等非 UUID 户型 ID，参考 [竞品测试](test/competitors.test.mjs)。
- 附件上传发送原始字节而非 multipart；文件名、分类、关联 ID 走查询参数，参考 [生产集成测试](test/production.test.mjs)。
- 研究任务采用“代理提交 → 人工勾选审核”的两阶段流程；代理无审批权，提交不写档案，更新须检查基线冲突并保留未选字段与附件。代理自报来源必须标注未独立核验，参考 [研究任务测试](test/research-tasks.test.mjs)。历史 AI 归档接口仍保留服务端来源校验，参考 [AI 归档测试](test/ai-archive.test.mjs) 与 [后端设计](BACKEND.md)。
- 扩展 API 时保留 `X-Workbench-Request: 1` 与 401 处理；AI 凭据只在服务端使用公开/私有访问器隔离，模型输出不作为 HTML 渲染。不要绕过来源校验、静态白名单、附件真实路径校验或现有 CSP。

## 开发与验证

运行完整测试，显式清除可能继承的生产配置：

```sh
cd /workspace/research-workbench
NODE_ENV=test HOST=127.0.0.1 PUBLIC_ORIGIN='' WORKBENCH_STORAGE=json WORKBENCH_HOME_VISUAL=false WORKBENCH_TRUST_PROXY=false npm test
```

- 单文件验证可将上述 `npm test` 换为 `node --test test/ai-archive.test.mjs` 等实际测试文件；涉及存储的测试可能共享前序用例数据，优先整文件运行。
- 新测试用临时目录隔离数据；存储模块在加载时读取环境，必须先设置 `WORKBENCH_DATA_DIR`，再动态导入，沿用 [竞品测试](test/competitors.test.mjs) 的模式。
- 服务子进程显式设置 `WORKBENCH_HOME_VISUAL=false`，AI 请求使用本机模拟上游，不读真实 TOKEN、不消耗真实接口额度。参考 [归档集成测试](test/ai-archive.test.mjs)。
- 多个集成测试使用固定端口，不同时运行两套测试；发生占用时先查来源，不停止未知服务。

需要本机预览时，使用独立临时资料目录，避免写入现有数据或触发默认首页联网抓图：

```sh
preview_dir="$(mktemp -d /tmp/workbench-preview.XXXXXX)"
NODE_ENV=development HOST=127.0.0.1 PORT=3000 PUBLIC_ORIGIN='' WORKBENCH_DATA_DIR="$preview_dir" WORKBENCH_STORAGE=json WORKBENCH_HOME_VISUAL=false WORKBENCH_TRUST_PROXY=false npm run dev
```

- `npm run dev` 是仅本机可用的空密码预览，不是热更新；后端修改需重启。临时目录不会自动清理，结束时报告路径，不做宽泛删除。

## 数据与部署护栏

- 默认不扫描或修改 `data/`、`runtime/`、`outputs/`、`releases/` 和 `@eaDir/`；前四者可能包含业务数据、凭据或生成物，后者是群晖元数据，不是源码。不要将其中内容写入指引或提交。
- 常规发布使用 `npm run package:release`，仅包含程序，不读取业务资料。`npm run package:demo` 会导出竞品及附件，须明确确认范围并设置 `WORKBENCH_EXPORT_DEMO=true`，不能用于普通验收。
- CI 负责完整测试；推送 `vX.Y.Z` 标签后发布流程重新测试、构建并验收 amd64 镜像，再发布 GHCR 与离线 Release。版本号须与 package.json 一致，不覆盖已有 Release。
- `workbench.sh upgrade` 从新版解压目录运行，目标为现有安装目录；先备份，再写单一原子版本配置 `runtime/release.yaml`，保留原 compose.yaml。回退仅适用于相同 dataSchema；不自动还原数据库。
- 备份包含敏感配置和聊天记录；[workbench.sh](workbench.sh) 的备份会暂停正在运行的服务，`prepare` 会递归调整数据/备份目录权限。初始化、重置凭据、备份、恢复、Docker 验收及部署前，先确认目标和副作用；操作步骤链接 [部署说明](DEPLOYMENT.md)，不要随手执行运维脚本验收代码。
- 仓库默认端口与 NAS 历史现场端口不同；更新前核实现有端口、挂载和镜像，不直接覆盖现场配置，不把本地测试或历史测试数量当作已上线证明。
