# 在 code-server 中运行和检查

本说明对应当前源码，包括可自定义分类的素材库和按城市分类的政策规范。此源码包不含线上数据库、账号密码、API 密钥或已归档项目的原件。

## 1. 放置源码

在群晖为开发版本单独建立目录，例如：

```text
/volume4/docker/caoguoooo-workbench-dev/
├── source/          # 本源码包解压到这里，目录中能直接看到 package.json
└── data-copy/       # 可选：由线上备份取得的完整资料副本
```

将 `source` 映射到已有 code-server 容器的工作目录，再在 code-server 中“打开文件夹”。实际映射路径和启动端口要根据现有 code-server 配置确认；不要覆盖正式服务的程序目录或直接挂载正式资料目录供开发写入。

## 2. 检查运行环境

在 code-server 的终端执行：

```sh
node --version
npm --version
```

项目需要 Node.js 24 或更新版本；使用原生 Node HTTP 服务和浏览器模块，不需要前端构建步骤。

进入源码目录，安装锁定的依赖：

```sh
npm ci
```

## 3. 先用独立的空资料库运行

初始化开发管理员，终端会提示输入密码（至少 8 位）：

```sh
WORKBENCH_DATA_DIR='./dev-data' npm run admin:init -- --username admin
npm run preview
```

`npm run preview` 固定使用独立的 `dev-data`、JSON 开发存储，关闭首页自动联网配图，并要求密码登录。它不读取部署环境的 `WORKBENCH_DATA_DIR`，不修改群晖正式服务。需要自定义目录时，初始化与运行必须指定同一个目录：

```sh
WORKBENCH_DATA_DIR='/workspace/data-copy' npm run admin:init -- --username admin
WORKBENCH_DEV_DATA_DIR='/workspace/data-copy' npm run preview
```

默认只监听本机 `127.0.0.1:3000`。如需从 NAS 内网直接查看，先为 code-server 容器额外映射一个未占用的测试端口，例如宿主机 `18898` → 容器 `3000`，再运行：

```sh
WORKBENCH_DEV_HOST=0.0.0.0 npm run preview
```

随后访问 `http://192.168.31.70:18898`。18898 是建议测试端口，应用前先确认空闲；正式服务仍使用原端口。页面使用从网站根路径开始的地址，单纯放在带前缀的代理路径下可能需要进一步适配。

## 4. 需要真实资料时再导入副本

正式竞品库使用 SQLite，而上述空库使用 JSON，不能把同一资料目录轮流交给两种存储模式写入。为查看真实项目，应从正式服务生成的一致性备份复制一整份到独立目录，再用与备份一致的存储模式运行，禁止直接指向正式资料目录。

例如备份中含有 `workbench.sqlite`，复制到 `/workspace/data-copy` 后，在 code-server 的源码目录运行：

```sh
NODE_ENV=development HOST=0.0.0.0 PORT=3000 PUBLIC_ORIGIN='' WORKBENCH_STORAGE=sqlite WORKBENCH_ALLOW_EMPTY_PASSWORD=false WORKBENCH_HOME_VISUAL=false WORKBENCH_TRUST_PROXY=false WORKBENCH_DATA_DIR='/workspace/data-copy' node server.mjs
```

这个副本含真实账号、配置及内部资料，应仅保留在自己的 NAS 工作目录，不打包提交 GitHub。正式备份中的原件与索引必须一起复制；只有数据库而没有 `competitor-files` 时图片不能正常显示。政策规范原件则位于 `policy-files`，索引为 `policy-library.json`；素材库使用 `asset-library.json` 和 `asset-files`。如要更改副本管理员密码，先停止开发进程，只对副本运行 `admin:init --reset`，不要对正式资料目录执行。

## 5. 检查与优化

```sh
NODE_ENV=test HOST=127.0.0.1 PUBLIC_ORIGIN='' WORKBENCH_STORAGE=json WORKBENCH_HOME_VISUAL=false WORKBENCH_TRUST_PROXY=false npm test
```

建议先检查这几项：

- 政策规范：城市/种类管理、上传、搜索、多城市关联、版本关联、回收站恢复。
- 权限：管理员可维护；普通用户只读且看不到回收站。
- 图片较多时的加载速度、左右目录滚动、移动端和深浅色表现。
- `server.mjs` 的接口拆分与 `competitor.js` 的界面拆分，按实际测试结果逐步优化。

前端文件保存后刷新页面；后端文件改动后，终端按 Ctrl+C 停止，再重新运行。通过独立开发版本确认效果后，再决定版本号和正式上线，开发目录不会自动发布到 GitHub 或群晖正式容器。
