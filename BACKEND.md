# caoguoooo-workbench · Demo 0.1.3 后端设计

部署目标：群晖 Docker，反向代理和 HTTPS 由使用者配置。群晖端口为 8899，容器内部端口为 3000；Node 提供页面、登录及 API，SQLite 存索引，文件保留在独立资料目录。项目名为 caoguoooo-workbench，当前为单管理员、单个后端实例。

## 数据模型

| 数据 | 持久化位置 | 关系与用途 |
|---|---|---|
| 楼盘 | SQLite `competitors` | 稳定 UUID；按城市索引；删除时间表示回收站 |
| 户型 / 楼层平面 | SQLite `floorplans` | `(project_id, id)` 唯一，保留排列位置 |
| 踩盘 | SQLite `visits` | 关联楼盘，保存日期与独立调查记录 |
| 文件索引 | SQLite `files` | 文件 UUID、类别、相对路径、可选户型及踩盘关联；外键约束 |
| 原始文件 | `/data/competitor-files/<楼盘ID>/` | `masterplan`、`renderings`、`floorplans/<户型ID>`、`visits/<踩盘ID>`、`documents` |
| 管理员 | `/data/auth.json` | scrypt 加盐密码哈希；正式版本从服务器本机初始化 |
| AI 配置 | `/data/ai-settings.json` | 仅后端读取 TOKEN；文件权限 600，当前未加密 |
| 会话 | 后端内存 | 随机 Cookie，12 小时有效；重启退出登录 |

各实体的完整业务字段保留在该表的 JSON payload 中，城市、名称、删除时间、文件类别、路径与关联字段另建列和索引。原型数据不丢字段，后续可继续将规划和价格拆成结构化列。

所有档案修改在 SQLite 的 `BEGIN IMMEDIATE` 事务里完成，外键保证文件与楼盘、踩盘、户型之间的关系。Demo 数据量较小，当前事务会重写该份完整档案集合；适合单用户 Demo，未来大量数据或多人协作需改为逐实体更新。SQLite 使用 WAL 与 FULL 同步配置；不支持在多个容器副本之间共享该数据库。

首次启动 SQLite 时只迁移一次 `competitors.json`，保留项目、户型、踩盘、文件 ID 和路径。旧 JSON 不删除，之后正式运行以数据库为准。开发预览默认仍用 JSON，禁止让两种模式同时修改同一资料目录。

## 接口与权限

| 接口 | 行为 |
|---|---|
| `GET /healthz` | 容器健康检查，不返回用户资料 |
| `/api/login`、`/api/logout`、`/api/status` | 登录与状态；正式 Cookie 具有 Secure、HttpOnly、SameSite=Strict |
| `/api/competitors` | 楼盘创建、读取、更新；默认排除回收站 |
| `/api/competitors/:id` 的 DELETE / restore | 可恢复删除，不移除原文件 |
| `/visits`、`/floorplans` | 调查和图纸位置维护 |
| `/files` | 单个文件最多25MB；登录后浏览；文件流与 Range 支持；校验文件实际路径 |
| `/api/settings/ai` | 保存 BASE_URL / TOKEN；读取不返回原 TOKEN |
| `/api/ai/models`、`/api/ai/chat` | 后端代理 OpenAI 兼容接口；超时、取消、长度限制、单用户并发保护 |

正式部署无需配置域名。网页 API 使用 X-Workbench-Request 请求头，后端拒绝缺少该头的写入请求、跨站及同站跨源请求；服务器不开放 CORS，因此其他网站的预检不能通过。该做法参考 [OWASP 自定义请求头方案](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#employing-custom-request-headers-for-ajaxapi)，不依赖反代是否改写 Host。正式 Cookie 仍为 Secure、HttpOnly、SameSite=Strict。PUBLIC_ORIGIN 仅作为旧接口的可选固定来源校验保留，不出现在部署配置中。正式版本禁用网页创建管理员和空密码模式；密码错误尝试限流，IP 转发头仅在明确启用受信任反代时使用。内部异常日志不输出 TOKEN、请求正文或文件内容。

## 运行与升级

镜像不包含账号、TOKEN 或真实运行数据；使用非 root 账号运行，镜像文件系统只读。NAS 的数据和备份目录单独挂载。初始化目录权限是隔离的一次性工具，不对公网开放。应用端口仅绑定 NAS 的127.0.0.1，禁止路由器直接转发后端3000端口。

Compose 仅定义一个 app 服务，配置使用字面值，不需要 .env。`workbench.sh init` 导入镜像、用无网络的一次性容器准备目录、初始化本地管理员并启动；初始化时仅临时增加目录权限所需的能力。应用运行时仍为非 root、只读文件系统并移除全部能力。脚本不会通过网页创建管理员或清空现有资料。`workbench.sh backup` 只对原本运行的应用暂停和恢复。

备份通过 SQLite 的备份 API 生成数据库副本，并复制原文件和配置。建议停止应用后执行备份，避免文件上传和配置更新期间产生不一致。恢复时停止应用，把备份复制到一个新目录，指向该新目录启动并验证；原目录保留供回退。

AI 当前只做文字对话，没有联网检索、图片下载、一键建档、自动读取附件等能力。项目资料、政策规范、素材库仍是分类入口，尚未实现资料写入。部署不会将这些占位功能描述为已完成。

参考：[Node SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)、[Docker 数据持久化](https://docs.docker.com/engine/storage/volumes/)。

## 主页每日配图

`home-visual.mjs` 读取 Designboom 公开首页的文章配图，从首页轮播和文章卡片中提取源图及原文链接，每个北京时间日期选择一张；15 分钟检查一次，失败后至少间隔一小时重试。缓存时间在重启后保留，同一天不重复抓取，下载失败保留上一张。仅访问 Designboom 指定 HTTPS 主机，校验重定向、图片格式、下载大小和超时。

图片和元数据位于资料目录的 `cache/home-visual/`；`/api/home-visual` 和 `/api/home-visual/image` 均要求登录。网页通过本机后端读取图片，保留 Designboom 原文链接，不在浏览器端直接访问第三方图像。定时刷新由工作台进程运行，不依赖用户打开浏览器。
