# caoguoooo-workbench · Demo 0.1.7 后端设计

部署目标：群晖 Docker，反向代理和 HTTPS 由使用者配置。群晖端口为 8899，容器内部端口为 3000；Node 提供页面、登录及 API，SQLite 存索引，文件保留在独立资料目录。项目名为 caoguoooo-workbench，当前为单管理员、单个后端实例。

## 数据模型

| 数据 | 持久化位置 | 关系与用途 |
|---|---|---|
| 楼盘 | SQLite `competitors` | 稳定 UUID；按城市索引；删除时间表示回收站 |
| 基本信息 / 周边配套 | 楼盘 payload 的 `basicInfo` / `amenities` | 主力户型、装修、特色、容积率、绿化率、开盘及交房时间；WGS84 项目位置、四类配套说明和点位 |
| 户型 / 楼层平面 | SQLite `floorplans` | `(project_id, id)` 唯一，保留排列位置 |
| 踩盘 | SQLite `visits` | 关联楼盘，保存日期与独立调查记录 |
| 文件索引 | SQLite `files` | 文件 UUID、类别、相对路径、可选户型及踩盘关联；外键约束 |
| 原始文件 | `/data/competitor-files/<楼盘ID>/` | `masterplan`、`renderings`、`floorplans/<户型ID>`、`visits/<踩盘ID>`、`documents` |
| 管理员 | `/data/auth.json` | scrypt 加盐密码哈希；正式版本从服务器本机初始化 |
| 用户资料 | `/data/user-profiles.json`、`/data/user-avatars/` | 昵称与经过完整解码、裁剪的头像；独立于登录凭据，纳入备份、排除演示包 |
| 注册用户 | `/data/users.json` | 加盐密码哈希、角色与审核状态；权限 600，备份包含此文件，演示包排除 |
| AI 配置 | `/data/ai-settings.json` | 仅后端读取 TOKEN；文件权限 600，当前未加密 |
| 地图配置 | `/data/map-settings.json` | 高德 Web 服务 Key、JS API Key 与 securityJsCode；权限 600，设置 API 只返回配置状态，安全密钥只在后端使用 |
| 普通会话 | 后端内存 | 随机 Cookie，最长 12 小时；不设置浏览器持久化期限，容器重启后退出 |
| 记住登录 | `/data/remembered-sessions.json` | 7 天绝对有效期；仅存随机凭据的 SHA256，关闭浏览器及重启容器后保留；登出和重设密码后失效 |
| 历史研究任务 | SQLite `archive_state` / JSON `researchTasks` | 仅保留历史内部状态与备份；当前无任务或代理接口 |

各实体的完整业务字段保留在该表的 JSON payload 中，城市、名称、删除时间、文件类别、路径与关联字段另建列和索引。原型数据不丢字段，后续可继续将规划和价格拆成结构化列。

所有档案修改在 SQLite 的 `BEGIN IMMEDIATE` 事务里完成，外键保证文件与楼盘、踩盘、户型之间的关系。Demo 数据量较小，当前事务会重写该份完整档案集合；适合单用户 Demo，未来大量数据或多人协作需改为逐实体更新。SQLite 使用 WAL 与 FULL 同步配置；不支持在多个容器副本之间共享该数据库。

首次启动 SQLite 时只迁移一次 `competitors.json`，保留项目、户型、踩盘、文件 ID 和路径。旧 JSON 不删除，之后正式运行以数据库为准。开发预览默认仍用 JSON，禁止让两种模式同时修改同一资料目录。

## 接口与权限

| 接口 | 行为 |
|---|---|
| `GET /healthz` | 容器健康检查，不返回用户资料 |
| `/api/login`、`/api/logout`、`/api/status` | 登录与状态；正式 Cookie 具有 Secure、HttpOnly、SameSite=Strict |
| `POST /api/account/password` | 已登录用户核验自己的当前密码并确认新密码，成功后该用户全部登录失效 |
| `POST /api/register` | 注册普通用户，初始状态待审核；不创建登录，不接受自选角色，密码至少 8 位 |
| `GET /api/admin/users` | 仅管理员读取用户列表，不返回密码哈希、盐或登录凭据 |
| `GET/PATCH /api/account/profile` | 登录用户读取和修改自己的昵称，不能修改角色、用户名或他人资料 |
| `POST/DELETE /api/account/avatar` | 上传或移除自己的头像；最大 5 MB，真实解码 JPG/PNG/WebP，去除元数据并统一输出 256×256 WebP |
| `GET /api/users/:username/avatar` | 登录后读取头像；被删除用户不可读取 |
| `PATCH /api/admin/users/:username/profile`、`POST/DELETE /api/admin/users/:username/avatar` | 管理员编辑用户昵称和头像，包括初始管理员的展示资料 |
| `DELETE /api/admin/users/:username` | 管理员删除其他用户，禁止删除初始管理员和当前账号；立即撤销该用户所有会话，保留业务档案 |
| `PATCH /api/admin/users/:username` | 管理员审批、调整角色、停用或重设其他用户密码；禁止变更初始管理员及自己的权限 |
| `/api/competitors` | 楼盘创建、读取、更新；默认排除回收站 |
| `PATCH /api/competitors/:id/amenities` | 保存位置、交通/教育/商业/医疗说明及最多 100 个点位；以 `expectedAmenities` 检测并发冲突 |
| `PATCH /api/competitors/:id/research` | 单独保存研究正文；以 `expectedReport` 检测并发冲突，不覆盖附件和来源 |
| `/api/competitors/:id` 的 DELETE / restore | 可恢复删除，不移除原文件 |
| `/visits`、`/floorplans` | 调查和图纸位置维护 |
| `/files` | 单个文件最多25MB；登录后浏览；文件流与 Range 支持；校验文件实际路径 |
| `PUT/DELETE /api/competitors/:id/files/:fileId` | 管理员替换或移除效果图；每项目最多 6 张，原文件与 `removedFiles` 元数据保留。替换以原文件 ID 检测冲突，新图成功存储后原子交换，失败清理新上传 |
| `POST /api/maps/refresh` | 管理员按城市和项目名称匹配高德，模糊同名拒绝自动选定；收集周边四类 POI，前端以 `expectedAmenities` 检测冲突后保存 |
| `/api/settings/ai` | 保存 BASE_URL / TOKEN；读取不返回原 TOKEN |
| `GET/PATCH /api/settings/maps` | 读取配置状态；分别保存/清除 Web 服务 Key 和 JS API Key + securityJsCode；空输入保留原值 |
| `GET /api/maps/client` | 已登录用户读取 JS API Key 与同源 serviceHost，不包含 securityJsCode |
| `GET /_AMapService/*` | 已登录用户的高德 SDK 固定路径代理；后端追加安全密钥，拒绝跨站请求、任意地址及重定向 |
| `POST /api/maps/search`、`/api/maps/nearby` | 按档案城市和案名查询位置，或读取项目周边 2 公里四类 POI；候选经用户选择后写入配套 |
| `/api/ai/models`、`/api/ai/chat` | 后端代理 OpenAI 兼容接口；超时、取消、长度限制、单用户并发保护 |

现有 `auth.json` 账号保留初始管理员权限，无需迁移密码。新注册账号固定为 `viewer/pending`，管理员审核激活后才能登录。普通用户只能浏览正常档案及附件；回收站、系统设置、AI、地图检索、研究任务、用户管理与所有资料写入均在后端拒绝，并在页面隐藏管理入口。普通用户可以修改自己的密码、昵称和头像、切换本机外观和退出登录。昵称和头像不会改变会话凭据；头像仅保存经过解码的 WebP 字节，使用随机文件名，不接受外部图片网址或 SVG，上传与附件共享最多三项并发限制。删除账号使用内部删除标记并清理展示资料，保留用户名占位，防止重新注册继承历史记录。页面右上角优先显示昵称，空昵称回退用户名。管理员变更角色、状态或密码会更新账号凭据版本，使该用户现有会话立即失效；其他账号会话不受影响。初始管理员不可在网页中停用或降级。

正式部署无需配置域名。网页 API 使用 X-Workbench-Request 请求头，后端拒绝缺少该头的写入请求、跨站及同站跨源请求；服务器不开放 CORS，因此其他网站的预检不能通过。该做法参考 [OWASP 自定义请求头方案](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#employing-custom-request-headers-for-ajaxapi)，不依赖反代是否改写 Host。正式 Cookie 仍为 Secure、HttpOnly、SameSite=Strict。PUBLIC_ORIGIN 仅作为旧接口的可选固定来源校验保留，不出现在部署配置中。正式版本禁用网页创建管理员和空密码模式；密码错误尝试限流，IP 转发头仅在明确启用受信任反代时使用。内部异常日志不输出 TOKEN、请求正文或文件内容。

## 运行与升级

概况表单在 `basicInfo` 中提交新增字段；旧客户端省略该对象时保留已存字段。旧档案可从概况文本推导已有信息，只有保存编辑才写入结构化字段。周边配套替换原踩盘记录展示区域，历史踩盘数据与附件关联继续保留。地图仅使用高德 JS API 2.0，不再分发或加载 Leaflet / OSM / 百度底图。教育配套只查询幼儿园、小学、中学细分类；JS SDK 与 Web 服务共用筛选规则，排除驾校、培训及其他教育类型。已确认的学校细分类以可选 `schoolType` 保存在点位中；历史数据浏览时过滤不支持的教育点位并重建自动说明，原始数据和人工备注不直接改写。位置与配套保存在档案，距离为 WGS84 球面直线距离，缺失坐标不估算距离。

镜像不包含账号、TOKEN 或真实运行数据；使用非 root 账号运行，镜像文件系统只读。NAS 的数据和备份目录单独挂载。初始化目录权限是隔离的一次性工具，不对公网开放。应用端口仅绑定 NAS 的127.0.0.1，禁止路由器直接转发后端3000端口。

Compose 仅定义一个 app 服务，配置使用字面值，不需要 .env。常规发布只打包程序，升级通过 runtime/release.yaml 选择版本，原 compose.yaml 保留；两个文件需由 workbench.sh 一起加载。升级前用新版镜像的备份脚本读取原挂载，覆盖用户资料、头像及历史配置，健康检查失败尝试兼容镜像回退。`workbench.sh init` 导入镜像、用无网络的一次性容器准备目录、初始化本地管理员并启动；初始化时仅临时增加目录权限所需的能力。应用运行时仍为非 root、只读文件系统并移除全部能力。脚本不会通过网页创建管理员或清空现有资料。`workbench.sh backup` 只对原本运行的应用暂停和恢复。

备份通过 SQLite 的备份 API 生成数据库副本，并复制原文件和配置。建议停止应用后执行备份，避免文件上传和配置更新期间产生不一致。恢复时停止应用，把备份复制到一个新目录，指向该新目录启动并验证；原目录保留供回退。

账号密码支持 8–128 字符。记住登录默认为未勾选；勾选后 Cookie 的 Max-Age 为 604800 秒，仍保留 HttpOnly、SameSite=Strict 和生产 Secure。服务器只保存令牌摘要，绑定账号密码哈希、盐及运行环境，每个实例最多 100 个会话。凭据文件权限 600，原子替换并串行写入；登出先撤销服务器记录再清除 Cookie，改密码后旧记录不能复用。不保存明文密码，不把登录令牌放进 localStorage。记住登录记录不纳入备份或演示资料，恢复备份后重新登录。参考 [OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。

设置中的“修改密码”校验当前密码、新密码及确认密码；新密码至少 8 位且不能与旧密码相同。对当前密码错误尝试按账号限流，每 15 分钟最多 10 次。登录与密码修改串行处理，防止并发旧密码登录生成新凭据对应的会话。账号文件原子替换后更新内存，密码指纹变化使所有普通和记住登录立即失效，清除当前 Cookie 并回到登录页。不会修改账号名称、项目档案或 AI 配置。
`
AI 支持普通文字对话，以及使用 Responses `web_search` 工具的联网检索。开启联网时发送到现有 BASE_URL 的 `/responses`，使用同一个 TOKEN 和用户选择的模型；接口及模型必须支持该工具。采用流式请求兼容中转，后端汇总为一条回复，180 秒超时、4MB 响应上限；只有返回已完成搜索调用及有效来源时才显示“已联网检索”，失败不会退回凭记忆生成资料。

来源 URL 和引用分别返回，前端安全地显示可点击链接。网页内容不作为操作指令。没有图片下载、一键建档或自动读取附件等能力，回复仍是草稿。项目资料、政策规范、素材库仍是分类入口，尚未实现资料写入。第三方中转接口的工具权限、上游限流和额度由服务商控制。参考 [OpenAI 联网搜索工具](https://developers.openai.com/api/docs/guides/tools-web-search)。

参考：[Node SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)、[Docker 数据持久化](https://docs.docker.com/engine/storage/volumes/)。

## 主页每日配图

地图优先使用高德 JS API 2.0，管理员在设置填写 Web 端（JS API）Key 及同一个 Key 的 securityJsCode。安全密钥只保存在服务器，由同源 `/_AMapService` 代理追加；客户端在加载 SDK 前配置 serviceHost。代理仅允许 SDK 使用的地点搜索、底图、样式和初始化路径，上游主机固定为高德 HTTPS 域名，不转发 Cookie 或接受任意目标，单次超时 15 秒、响应不超过 2 MiB。地图在同源子页面加载，仅该子页面开放 SDK 所需的资源策略，主工作台 CSP 保持不变；消息校验 origin 和 source。JS API Key 作为浏览器公开标识按高德要求使用，应在控制台配置当前访问域名白名单。可在设置中“保存并检测地图”验证 SDK 和地点查询。原 Web 服务 Key 保留为未配置 JS API 时的查询备选；未配置 JS API 时显示配置提示，保留位置和配套清单。地图/搜索结果使用 GCJ-02，档案仍保存 WGS84，显示、选点及搜索均做双向转换，避免升级后已有点位偏移。普通用户只能浏览已保存点位；搜索结果仍由管理员确认后保存。参见 [高德安全密钥官方说明](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)。

`home-visual.mjs` 读取 Designboom 公开首页的文章配图，从首页轮播和文章卡片中提取源图及原文链接，首页不可用时读取公开 RSS 备用源，每个北京时间日期选择一张；15 分钟检查一次，失败后至少间隔 10 分钟重试。缓存时间在重启后保留，正常情况下同一天不重复抓取，管理员可手动更新（至少间隔 60 秒），下载失败保留上一张。仅访问 Designboom 指定 HTTPS 主机，校验重定向、图片格式、下载大小和超时。

图片和元数据位于资料目录的 `cache/home-visual/`；`/api/home-visual` 和 `/api/home-visual/image` 均要求登录。网页通过本机后端读取图片，保留 Designboom 原文链接，不在浏览器端直接访问第三方图像。定时刷新由工作台进程运行，不依赖用户打开浏览器。

## 已停用的研究任务

Hermes 页面、任务创建/审批及执行 worker 已移除。原 `/api/research-tasks*`、`/api/agent/*` 统一返回 410，旧凭据不能继续读取或写入任务。历史任务、档案研究正文和历史审核记录保留在备份数据；竞品研究正文仍可由管理员编辑。

## AI 整理及归档（历史兼容）

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
