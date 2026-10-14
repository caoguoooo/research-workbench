# caoguoooo-workbench · Demo 0.1.8 后端设计

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
| 普通会话 | 后端内存 | 随机 Cookie，最长 12 小时；不设置浏览器持久化期限，容器重启后退出 |
| 记住登录 | `/data/remembered-sessions.json` | 7 天绝对有效期；仅存随机凭据的 SHA256，关闭浏览器及重启容器后保留；登出和重设密码后失效 |

各实体的完整业务字段保留在该表的 JSON payload 中，城市、名称、删除时间、文件类别、路径与关联字段另建列和索引。原型数据不丢字段，后续可继续将规划和价格拆成结构化列。

所有档案修改在 SQLite 的 `BEGIN IMMEDIATE` 事务里完成，外键保证文件与楼盘、踩盘、户型之间的关系。Demo 数据量较小，当前事务会重写该份完整档案集合；适合单用户 Demo，未来大量数据或多人协作需改为逐实体更新。SQLite 使用 WAL 与 FULL 同步配置；不支持在多个容器副本之间共享该数据库。

首次启动 SQLite 时只迁移一次 `competitors.json`，保留项目、户型、踩盘、文件 ID 和路径。旧 JSON 不删除，之后正式运行以数据库为准。开发预览默认仍用 JSON，禁止让两种模式同时修改同一资料目录。

## 接口与权限

| 接口 | 行为 |
|---|---|
| `GET /healthz` | 容器健康检查，不返回用户资料 |
| `/api/login`、`/api/logout`、`/api/status` | 登录与状态；正式 Cookie 具有 Secure、HttpOnly、SameSite=Strict |
| `POST /api/account/password` | 已登录管理员核验当前密码并确认新密码，成功后全部登录失效 |
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

账号密码支持 8–128 字符。记住登录默认为未勾选；勾选后 Cookie 的 Max-Age 为 604800 秒，仍保留 HttpOnly、SameSite=Strict 和生产 Secure。服务器只保存令牌摘要，绑定账号密码哈希、盐及运行环境，每个实例最多 100 个会话。凭据文件权限 600，原子替换并串行写入；登出先撤销服务器记录再清除 Cookie，改密码后旧记录不能复用。不保存明文密码，不把登录令牌放进 localStorage。记住登录记录不纳入备份或演示资料，恢复备份后重新登录。参考 [OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。

设置中的“修改密码”校验当前密码、新密码及确认密码；新密码至少 8 位且不能与旧密码相同。对当前密码错误尝试按账号限流，每 15 分钟最多 10 次。登录与密码修改串行处理，防止并发旧密码登录生成新凭据对应的会话。账号文件原子替换后更新内存，密码指纹变化使所有普通和记住登录立即失效，清除当前 Cookie 并回到登录页。不会修改账号名称、项目档案或 AI 配置。
`
AI 支持普通文字对话，以及使用 Responses `web_search` 工具的联网检索。开启联网时发送到现有 BASE_URL 的 `/responses`，使用同一个 TOKEN 和用户选择的模型；接口及模型必须支持该工具。采用流式请求兼容中转，后端汇总为一条回复，180 秒超时、4MB 响应上限；只有返回已完成搜索调用及有效来源时才显示“已联网检索”，失败不会退回凭记忆生成资料。

来源 URL 和引用分别返回，前端安全地显示可点击链接。网页内容不作为操作指令。没有图片下载、一键建档或自动读取附件等能力，回复仍是草稿。项目资料、政策规范、素材库仍是分类入口，尚未实现资料写入。第三方中转接口的工具权限、上游限流和额度由服务商控制。参考 [OpenAI 联网搜索工具](https://developers.openai.com/api/docs/guides/tools-web-search)。

参考：[Node SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)、[Docker 数据持久化](https://docs.docker.com/engine/storage/volumes/)。

## 主页每日配图

`home-visual.mjs` 读取 Designboom 公开首页的文章配图，从首页轮播和文章卡片中提取源图及原文链接，每个北京时间日期选择一张；15 分钟检查一次，失败后至少间隔一小时重试。缓存时间在重启后保留，同一天不重复抓取，下载失败保留上一张。仅访问 Designboom 指定 HTTPS 主机，校验重定向、图片格式、下载大小和超时。

图片和元数据位于资料目录的 `cache/home-visual/`；`/api/home-visual` 和 `/api/home-visual/image` 均要求登录。网页通过本机后端读取图片，保留 Designboom 原文链接，不在浏览器端直接访问第三方图像。定时刷新由工作台进程运行，不依赖用户打开浏览器。

## AI 整理及归档

AI 对话中的“整理为档案”使用当前模型、联网选项及对话上下文生成结构化资料，仅创建服务端草稿，尚不写入竞品库。接口为 POST /api/ai/chat，archiveDraft=true；模型须返回符合格式的 JSON。项目身份不明确时要求补充城市。草稿随聊天记录按账号保存，重启后仍可归档；内存缓存 30 分钟，单账号最多 20 份，缓存失效后从对应的持久化对话恢复。

检查名称、城市及基础信息后，POST /api/ai/archive 提交 draftId 和 project，原子保存项目、至少三个户型位置和 aiResearch（章节全文、检索来源、模型及生成时间）。保存不再请求 AI，不增加实地踩盘或虚假附件。JSON 和 SQLite 均持久保留该字段；编辑普通概况不会丢失 AI 资料。重复保存同一草稿幂等，同城市同名项目返回冲突，不自动覆盖。来源仅采用服务端实际检索结果，忽略模型自行生成的 sources 字段。

图片仍需上传至已有总规划、效果图、户型图位置；此版本不自动下载网络图片。真实联网还取决于已配置接口和模型是否支持 Responses web_search 及其额度。

## AI 聊天记录

记录在资料目录的 `ai-conversations.json`，以权限 600 原子写入，包含账号归属、对话 ID、标题、模型、联网选项、用户消息、完整回复、引用来源和档案草稿。成功回复写入服务端后才返回浏览器。GET `/api/ai/conversations` 返回当前账号的历史和最近一段对话，`?id=` 读取指定对话；POST 创建新对话并保留旧记录。聊天请求携带 conversationId 继续原对话。每账号最多 50 段、每段 200 条消息，整个记录文件最多 24 MB；达到限制明确报错，不静默删除记录。

关闭窗口继续等待正在生成的回复，“停止”才主动取消。页面刷新或重新登录时从服务端恢复记录、模型、来源和草稿；已归档草稿显示“查看档案”。记录随备份保留，不放入源码演示包。该功能启用前未保存的聊天记录无法追溯恢复。

POST `/api/ai/conversations/select` 选择当前账号的历史对话；选择状态也保存到服务端，刷新或重启后恢复同一段对话。

## 2026-10-12 AI 无响应修正与真实接口检查

受保护的聊天、档案及设置接口返回 401 时，前端跳转登录并显示登录已失效；模型列表中存在 gpt-5.2 时自动填入，仍允许手动更换。请求等待设有超时，发送失败直接显示在聊天气泡中，并保留输入用于重试。服务端将经过脱敏的 AI 服务失败说明与用户消息保存到对话中；这些失败消息只展示，不作为后续模型对话上下文。

本地现有接口的模型列表读取成功，但普通/联网请求均观察到上游限流；联网实测返回 HTTP 429，原因是所有可用账号受到限流。没有成功生成真实联网回复。已经在真实网页验证限流提示以及刷新后的失败记录恢复。需上游服务恢复可用账号或额度，或者使用另一个可用接口。
