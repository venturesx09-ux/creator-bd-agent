# Creator BD Agent — Phase 5.4.1

这是Creator BD Agent的“邮件分析与飞书写回工作台”。当前版本保留IMAP只读同步、飞书匹配和AI分析，并暂停旧的回复草稿与邮件发送界面：

- 使用OpenAI兼容的Responses API和结构化输出分析达人回复；
- 自动生成中文摘要，提取报价原文和标准化报价，支持单价、总价、区间、多个套餐、币种、交付内容、档期、权益、付款要求和风险；
- 当前不生成任何中英文回复草稿，回复模板和界面留待后续重新设计；
- AI分析结果使用AES-256-GCM加密后保存到PostgreSQL；
- 匹配达人后，把`AI中文摘要`、`报价`、`报价金额`、`报价币种`、`权益要求`写回飞书；没有识别到报价时，`报价`固定写入`未提及报价`；
- 管理页提供原邮件/AI结果双栏查看；AI分析自动执行，不显示“AI分析/重新分析”按钮；
- 管理页左侧展示邮件正文，右侧只显示中文摘要；报价分析继续写回飞书，但不在当前界面展开；不提供草稿编辑或邮件发送入口；
- OpenAI请求不持久化到OpenAI服务（`store: false`），API Key不进入代码、响应或日志；

已有基础能力包括：

- Render服务可以正常运行；
- 飞书应用可以自动获取`tenant_access_token`；
- 机器人可以向指定测试群发送消息；
- 机器人可以安全接收群内`@机器人 测试`并自动回复；
- 程序可以读取和更新飞书Base测试记录。
- 受`ADMIN_TOKEN`保护的邮箱管理页面；
- PostgreSQL持久化存储；
- AES-256-GCM加密邮箱凭证和邮件内容；
- 一个或多个邮箱的IMAP连接测试与只读同步；
- 通过IMAP UID、UIDVALIDITY和Message-ID哈希去重。
- 每2分钟自动同步所有已启用邮箱，为“收到邮件后约3分钟内写入飞书”的目标预留处理时间；
- UID增量同步之外额外回抓最多200封尚未入库的未读邮件，修复首次同步遗漏；
- 邮件规则分类：达人回复、自动回复、退信、批量/系统通知；
- 读取飞书Base并按发件邮箱匹配达人记录；
- 管理页显示过去24小时邮件与匹配概览；
- 邮箱启用、停用以及空邮箱安全删除。
- 支持扫描最多50,000条飞书达人记录，并在同一同步周期缓存邮箱索引。
- 使用完整字段JSON提取嵌套邮箱，并在`total`显示仍有记录时继续分页。
- 修复旧邮件被标记为未匹配后无法再次匹配的问题。
- 飞书大表匹配改为后台任务，避免一万多行扫描导致同步请求超时；同一周期复用索引。
- 匹配成功后写回最近发件邮箱、最后联系时间、邮件同步状态和邮件分类；普通达人回复仅在早期阶段推进为已回复。
- 飞书邮箱索引以SHA-256哈希持久化到PostgreSQL，重启后无需先重新扫描一万多行；索引每30分钟后台刷新。
- 管理页刷新后在同一标签会话内保持登录，并提供刷新概览、刷新邮箱、刷新邮件、全部同步和同步进度条。
- 新增飞书后台实时进度：索引读取行数、任务总数、已处理、匹配成功、未匹配、写回成功和失败；管理页每2秒自动刷新。
- 单条飞书写回失败不再中断整批处理，失败邮件保留并在后续同步重试。
- 修复PostgreSQL在记录匹配结果时对参数类型推断冲突，避免飞书已写回但本地状态被误记为失败。
- 邮箱无法匹配时，从引用历史中提取`Hi + 达人ID`，与飞书`达人ID`唯一匹配；成功后把当前回复邮箱写入`最近发件邮箱`，不覆盖原达人邮箱。
- 发件邮箱匹配失败后，优先提取邮件标题里的`@达人ID`与飞书`达人ID`匹配，再回退到历史正文匹配；不会把邮箱地址中的域名误识别成达人ID。
- 只有“达人回复”会进入飞书达人匹配；自动回复、退信和批量通知即使标题包含`@达人ID`也显示“无需匹配”，不会写回达人记录或进入待匹配队列。
- 管理页增加“立即刷新飞书索引”，无需等待30分钟缓存过期。
- 最近邮件显示匹配依据或未匹配原因，包括历史缺少达人ID、达人ID不存在和达人ID重复。
- 未匹配邮件自动写入独立的飞书“待匹配邮件”子表；同一邮件只维护一行，后续匹配成功后自动标记为“已匹配”。
- 过去24小时概览区分已匹配邮件、唯一匹配达人和重复回复邮件，避免把多封回复误算成多位达人。

自动任务只读取邮箱、分析并写回飞书。当前没有草稿生成、草稿编辑或邮件发送入口。

## 安全提醒

如果任何App Secret、Verification Token、Encrypt Key或访问Token曾经出现在聊天或日志中，请先在飞书后台重置，再部署本项目。真实值只能填写在Render Environment，不能写入代码或提交到GitHub。

## 接口

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/health` | 无 | Render健康检查，不返回密钥 |
| POST | `/feishu/events` | 飞书签名、Token及加密校验 | 接收飞书事件订阅 |
| GET | `/admin` | 页面本身无数据 | 邮箱管理页面 |
| GET | `/api/admin/mailboxes` | ADMIN_TOKEN | 安全列出邮箱（不返回密码） |
| POST | `/api/admin/mailboxes` | ADMIN_TOKEN | 加密保存邮箱 |
| POST | `/api/admin/mailboxes/:mailboxId/test` | ADMIN_TOKEN | 测试IMAP连接 |
| POST | `/api/admin/mailboxes/:mailboxId/smtp/config` | ADMIN_TOKEN | 加密保存或更换SMTP配置，并自动停用发送 |
| POST | `/api/admin/mailboxes/:mailboxId/smtp/test` | ADMIN_TOKEN | 只测试SMTP连接与登录，不发送邮件 |
| PATCH | `/api/admin/mailboxes/:mailboxId/smtp/status` | ADMIN_TOKEN | 启用或停用唯一试点SMTP邮箱 |
| POST | `/api/admin/mailboxes/:mailboxId/sync` | ADMIN_TOKEN | 手动执行IMAP只读同步 |
| GET | `/api/admin/mailboxes/:mailboxId/messages` | ADMIN_TOKEN | 查看已同步邮件摘要 |
| POST | `/api/admin/mailboxes/:mailboxId/messages/:messageId/analyze` | ADMIN_TOKEN | 保留的受保护诊断接口；日常流程无需调用 |
| PATCH | `/api/admin/mailboxes/:mailboxId/status` | ADMIN_TOKEN | 启用或停用邮箱 |
| DELETE | `/api/admin/mailboxes/:mailboxId` | ADMIN_TOKEN | 删除没有同步记录的空邮箱 |
| GET | `/api/admin/daily-summary` | ADMIN_TOKEN | 过去24小时分类与匹配统计 |
| GET | `/api/admin/feishu/progress` | ADMIN_TOKEN | 查询飞书索引、匹配和写回实时进度 |
| POST | `/api/admin/feishu/index/refresh` | ADMIN_TOKEN | 在后台立即刷新飞书邮箱与达人ID索引 |
| POST | `/api/test/feishu/messages` | ADMIN_TOKEN | 向测试群发送文本消息 |
| GET | `/api/test/feishu/base/records` | ADMIN_TOKEN | 列出Base记录 |
| PATCH | `/api/test/feishu/base/records/:recordId` | ADMIN_TOKEN | 更新指定测试记录 |

受保护接口统一使用：

```http
Authorization: Bearer <ADMIN_TOKEN>
```

## 环境变量

复制`.env.example`作为配置参考。不要把真实`.env`提交到GitHub。

| 变量 | 必填 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | 是 | 飞书自建应用App ID |
| `FEISHU_APP_SECRET` | 是 | 飞书自建应用App Secret |
| `FEISHU_VERIFICATION_TOKEN` | 是 | Webhook事件来源校验 |
| `FEISHU_ENCRYPT_KEY` | 是 | Webhook签名校验及AES-256-CBC解密 |
| `FEISHU_BASE_APP_TOKEN` | 是 | Wiki节点接口返回的`obj_token` |
| `FEISHU_BASE_TABLE_ID` | 是 | Base网址`table=`后的值 |
| `FEISHU_UNMATCHED_TABLE_ID` | 否 | “待匹配邮件”子表ID；填写后启用未匹配队列写回 |
| `ADMIN_TOKEN` | 是 | 至少32个随机字符 |
| `DATABASE_URL` | 是 | PostgreSQL内部连接地址；Blueprint自动注入 |
| `DATABASE_SSL` | 否 | Render内部数据库连接填写`false` |
| `MAILBOX_ENCRYPTION_KEY` | 是 | 独立的32字节Base64密钥；Blueprint自动生成 |
| `MAILBOX_INITIAL_SYNC_LIMIT` | 否 | 首次同步最近多少封，默认20，最大100 |
| `MAILBOX_SYNC_INTERVAL_MINUTES` | 否 | 自动只读同步间隔，默认2，可设置1至60 |
| `OPENAI_API_KEY` | 是 | OpenAI或AIHubMix API Key，只保存于Render Environment |
| `OPENAI_BASE_URL` | 否 | AI兼容接口地址；AIHubMix填写`https://aihubmix.com/v1` |
| `OPENAI_MODEL` | 否 | 分析模型，默认`gpt-5.6-luna` |
| `PORT` | 否 | 默认3000；Render会自动提供 |

不要保存临时`tenant_access_token`。程序会使用App ID和App Secret自动获取并缓存。

### 待匹配邮件子表

在同一个飞书Base中新建`待匹配邮件`数据表，并按下表创建字段。第一列主字段使用`待匹配邮件ID`。把该表网址中`table=`后的值填入Render环境变量`FEISHU_UNMATCHED_TABLE_ID`。

| 字段 | 推荐类型 |
|---|---|
| `待匹配邮件ID` | 单行文本（主字段） |
| `发件人名称` | 单行文本 |
| `发件邮箱` | 单行文本 |
| `收件邮箱` | 单行文本 |
| `项目` | 单行文本 |
| `邮件主题` | 单行文本 |
| `邮件分类` | 单选 |
| `收件时间` | 日期 |
| `未匹配原因` | 单行文本 |
| `历史识别达人ID` | 单行文本 |
| `邮件预览` | 多行文本 |
| `AI中文摘要` | 多行文本 |
| `报价` | 多行文本 |
| `处理状态` | 单选（`待处理`、`已匹配`） |
| `最终匹配达人ID` | 单行文本 |
| `最终匹配记录ID` | 单行文本 |
| `解决时间` | 日期 |

每封未匹配邮件只创建一行，后续重试只更新原行。AI分析完成后会自动补充中文摘要和报价；未提及报价时写入`未提及报价`。以后匹配成功时，原行自动改为`已匹配`并记录最终达人及解决时间。

## 本地验证

需要Node.js 22：

```bash
npm ci
npm run check
```

测试使用模拟飞书API、模拟IMAP/SMTP和模拟AI分析，不需要真实密钥，不连接真实邮箱，不调用OpenAI，也不会发送真实邮件。

如需用本地环境手动启动，可创建不提交的`.env`，然后运行：

```bash
node --env-file=.env --import tsx src/server.ts
```

打开：

```text
http://localhost:3000/health
```

## 上传到GitHub

1. 登录GitHub并创建名为`creator-bd-agent`的Private仓库。
2. 不要让GitHub自动生成README、`.gitignore`或License。
3. 解压项目，将项目目录中的文件上传到仓库根目录。
4. 上传前确认仓库里没有`.env`、`.env.local`或真实密钥。
5. GitHub中应当有`package.json`、`Dockerfile`、`render.yaml`和`src/`。

## 在Render部署

1. 登录Render。
2. 点击`New` → `Blueprint`。
3. 连接并选择GitHub中的`creator-bd-agent`私有仓库。
4. Render会读取根目录的`render.yaml`。
5. Blueprint会创建`creator-bd-agent-db` PostgreSQL数据库，并通过内部网络注入`DATABASE_URL`；
6. Blueprint会自动生成`ADMIN_TOKEN`和独立的`MAILBOX_ENCRYPTION_KEY`；
7. 对于已经存在的Blueprint，上传4.0代码后在Render的Blueprint页面点击`Sync Blueprint`；
8. 等数据库为`Available`、服务为`Live`；
9. 打开Render生成的域名加`/health`。

正确结果类似：

```json
{
  "status": "ok",
  "service": "creator-bd-agent",
  "configuration": {
    "feishuCoreConfigured": true,
    "callbackSecurityConfigured": true,
    "mailboxStorageConfigured": true
  }
}
```

免费实例会休眠，休眠期间定时任务不会运行，唤醒后会从上次IMAP UID继续同步。要稳定实现“收到邮件后约3分钟内写入飞书”，必须把Render Web Service升级为不会休眠的付费实例；代码轮询间隔已经设为2分钟。SMTP只会响应人工点击，不参与定时任务。

## 使用邮箱管理页面

部署成功后打开：

```text
https://你的Render域名/admin
```

1. 从Render Environment复制当前`ADMIN_TOKEN`；
2. 在页面输入Token并点击`进入管理`；同一浏览器标签内刷新页面不需要重新输入，关闭标签或点击“退出”后清除；
3. 填写邮箱地址、IMAP服务器、端口、加密方式、用户名和应用专用密码；
4. 点击`加密保存邮箱`；
5. 点击`测试IMAP`，确认连接成功；
6. 点击`只读同步`；系统读取新UID，并回抓最多200封尚未入库的未读邮件；
7. 点击`查看最近邮件`检查主题、发件人、原文和AI结果；旧邮件可点击`AI分析`，已分析邮件可点击`重新分析`。
8. 查看顶部“过去24小时”，确认分类和飞书匹配数量；
9. 错误的重复邮箱可点击`停用`；若从未同步过邮件，可点击`删除`。

支持两种强制加密连接：

- 端口993 + SSL/TLS；
- 端口143 + STARTTLS。

系统使用IMAP只读模式打开`INBOX`，不会修改已读状态、移动或删除邮件。常规增量每批最多100封，并额外补抓最多200封遗漏的未读邮件；自动任务会继续处理后续批次。邮箱停用后不会再自动或手动同步，但历史邮件仍会保留。

## 第三阶段分类与飞书匹配

分类使用确定性规则，不调用AI：

- `达人回复`：普通外部联系人回复；
- `自动回复`：识别Auto-Submitted、Automatic Reply、Out of Office等；
- `退信`：识别Mailer-Daemon、Postmaster及投递失败主题；
- `批量/通知`：识别Precedence、List-ID和no-reply等。

每次同步后，程序会依次尝试：飞书字段中的完整发件邮箱、当前回复签名中的Instagram/TikTok/YouTube/X个人主页、发件邮箱用户名、邮件标题中的`@达人ID`、回复线程中的`Hi/Hello/Hey/Dear + 达人ID`。签名匹配只读取当前回复，不读取引用历史中的品牌或其他社媒链接。飞书达人ID支持纯ID、`@ID`、Instagram/TikTok/YouTube/X链接，以及`IG: ID`等带平台前缀格式。所有方式都做不区分大小写的精确匹配，只有唯一命中才写回，不使用可能误匹配达人的模糊猜测。首次未命中时会自动强制刷新飞书索引再尝试一次，处理新添加达人或缓存尚未更新的情况。邮箱和达人ID索引都只以不可逆SHA-256哈希保存在PostgreSQL，重启后直接复用，并每30分钟后台刷新，也可以在管理页手动立即刷新。升级前同步的旧邮件会自动重新匹配；未匹配邮件会在后续同步时重试，并在配置`FEISHU_UNMATCHED_TABLE_ID`后写入独立子表。程序在PostgreSQL保存对应子表记录ID，因此重复同步只更新原行；邮件以后匹配成功时，原行自动更新处理状态、最终记录ID和解决时间。匹配成功后会安全写回“最近发件邮箱、最后联系时间、邮件同步状态、邮件分类”，并只把早期合作阶段推进为“已回复”。同时，每封匹配成功的达人回复会以邮件唯一ID写入内部事件表并重新计算同一达人行的累计回复数、首次/最近回复时间和逐封明细，重复同步不会重复计数。日期字段使用邮件实际收件时间，`回复邮件明细`使用北京时间，不使用批量写回时间。如果引用历史被对方完全删除，当前仅同步INBOX的版本无法还原首封发件内容。

飞书达人主表还需要存在以下字段，名称和类型必须完全一致：

| 字段 | 推荐类型 |
|---|---|
| `累计回复邮件数` | 数字 |
| `首次回复时间` | 日期 |
| `最近回复时间` | 日期 |
| `回复邮件明细` | 多行文本 |

`累计回复邮件数`只统计被分类为`达人回复`且成功匹配到该达人行的唯一邮件。邮箱INBOX总数还可能包含自动回复、退信、群发通知及未匹配邮件，因此两者不是同一统计口径。升级后，历史已匹配回复会按每个邮箱每批最多500封自动补写以上四个字段，无需手动点击分析。

## 第四阶段AI分析

新同步和升级前已存在的`达人回复`都会在后台进入AI分析并逐批回填，保证匹配成功的已回复记录拥有中文摘要和报价信息。升级到5.1后，旧报价结构的邮件会按每个邮箱每批最多100封从IMAP重新读取原始邮件并重新分析一次，完成后不会重复消耗额度。HTML邮件会先转换为纯文本，最多保留30,000字符用于覆盖较长的历史线程。报价分析同时读取最新回复和引用历史，区分单价、总价、区间和多个套餐，并避免把品牌预算、产品价值、联盟佣金或已完成项目的invoice误认成达人当前报价。分析失败的邮件会在至少30分钟后自动重试。

AI回复草稿功能当前已停用：模型固定返回空草稿，工作台不显示草稿编辑区，飞书不再写入`AI回复草稿`，草稿和发送API也不再暴露。后续回复模板和界面将独立重新设计。

飞书主表需要存在以下字段，名称和类型应完全一致：

| 字段 | 推荐类型 |
|---|---|
| `AI中文摘要` | 多行文本 |
| `报价` | 多行文本（必需；无报价时写入“未提及报价”） |
| `报价金额` | 数字 |
| `报价币种` | 单选（提前加入USD、EUR、GBP等选项） |
| `交付内容` | 多行文本 |
| `权益要求` | 多行文本 |

如果AI已经分析成功、但飞书某个字段不存在或单选值不可用，工作台会显示`等待写回/写回失败`；修好飞书字段后，后台同步会自动重试写回，无需点击AI分析。

## 回复功能状态

旧版SMTP配置数据仍加密保留，方便后续重新设计回复模板和界面时复用；当前工作台不显示草稿编辑区，草稿与发送API均已移除，因此不会从当前界面发出邮件。

## 配置飞书消息接收

必须先将3.0.0版代码部署到Render，再配置事件订阅。

1. 飞书开放平台进入应用，打开`权限管理`；
2. 开通`获取群组中用户@机器人消息`（`im:message.group_at_msg:readonly`）；
3. 创建新版本、提交审批并发布；
4. 进入`事件与回调`或`事件订阅`，选择`将事件发送至开发者服务器`；
5. 请求地址填写`https://你的Render域名/feishu/events`；
6. 保存地址，飞书会发送challenge请求完成校验；
7. 添加事件`接收消息`（`im.message.receive_v1`）；
8. 再次创建并发布包含事件订阅的新版本；
9. 将机器人加入内部测试群，在群中发送`@机器人 测试`。

正确结果：

```text
Creator BD Agent运行正常 ✅
```

URL Challenge阶段使用Verification Token与App ID校验并原样返回challenge；正式事件会额外强制验证飞书请求签名。启用Encrypt Key后会解密加密事件。相同`event_id`在单实例内10分钟只处理一次，避免飞书重试造成重复回复。事件正文和密钥不会写入日志。

## 获取测试群chat_id

可以通过飞书“获取机器人所在群列表”接口查找。不要把临时访问Token发到聊天中。把得到的`chat_id`只用于下面的测试请求。

## 发送飞书测试消息

在自己的终端中设置临时变量，不要把真实值保存到脚本或聊天：

```bash
curl -X POST "https://你的Render域名/api/test/feishu/messages" \
  -H "Authorization: Bearer 你的ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chat_id":"你的测试群chat_id"}'
```

测试群应收到：

```text
Creator BD Agent飞书连接测试成功 ✅
```

## 读取Base记录

```bash
curl "https://你的Render域名/api/test/feishu/base/records?page_size=20" \
  -H "Authorization: Bearer 你的ADMIN_TOKEN"
```

在响应中找到`API测试记录`对应的`record_id`。

## 更新测试记录

```bash
curl -X PATCH "https://你的Render域名/api/test/feishu/base/records/你的record_id" \
  -H "Authorization: Bearer 你的ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fields":{"系统测试":"读取和更新成功"}}'
```

回到飞书Base，确认`系统测试`字段发生变化。

## 常见错误

### Render部署失败

- 检查部署日志；
- 确认Docker构建成功；
- 确认必填环境变量已填写；
- 不要手动设置Render的`PORT`。

### `/health`打不开

- 确认服务状态为`Live`；
- 确认Health Check Path为`/health`；
- 服务必须监听`0.0.0.0`，本项目已配置。

### 飞书返回401或访问Token错误

- 检查App ID和重置后的App Secret；
- 确认变量值没有多余空格；
- 不要在环境变量值前添加`Bearer`。

### Base返回403或权限不足

- 确认应用已开通Base读取和更新权限；
- 权限变更后创建并发布新版本；
- 将目标Base添加给应用并授予编辑权限；
- 确认App Token使用Wiki接口返回的`obj_token`。

### 更新记录失败

- 确认使用的是`record_id`，不是行号；
- 确认字段名与飞书Base完全一致；
- 测试字段`系统测试`应为文本类型。

### 邮箱管理页面显示服务不可用

- 在Render Blueprint页面点击`Sync Blueprint`；
- 确认`creator-bd-agent-db`状态为`Available`；
- 确认服务环境变量存在`DATABASE_URL`和`MAILBOX_ENCRYPTION_KEY`；
- 不要把这些变量值发到聊天中。

### IMAP连接失败

- 确认邮箱服务商已经开启IMAP；
- 优先使用应用专用密码，不要使用网页登录密码；
- 确认服务器、端口和TLS方式完全匹配；
- 部分企业邮箱会限制海外服务器IP，需要向服务商申请放行。

## 第五阶段验收

- [ ] `npm run check`全部通过；
- [ ] GitHub仓库为Private；
- [ ] GitHub中没有真实密钥；
- [ ] Render服务为`Live`；
- [ ] `/health`返回200且不泄露密钥；
- [ ] 测试群收到机器人消息；
- [ ] 飞书事件订阅地址校验成功；
- [ ] 群内发送`@机器人 测试`后收到自动回复；
- [ ] 程序能列出Base记录；
- [ ] 程序能更新`API测试记录`；
- [ ] 所有写接口都需要`ADMIN_TOKEN`；
- [ ] PostgreSQL数据库为`Available`；
- [ ] `/health`显示`mailboxStorageConfigured: true`；
- [ ] `/admin`可以使用`ADMIN_TOKEN`进入；
- [ ] 邮箱密码不会通过任何接口返回；
- [ ] 一个试点邮箱通过IMAP连接测试；
- [ ] 能以只读模式同步最近邮件且不会修改已读状态；
- [ ] 重复同步不会重复保存同一封邮件；
- [ ] `/health`显示当前版本且`openaiConfigured: true`；
- [ ] 管理页顶部显示过去24小时摘要；
- [ ] 打开最近邮件后可看到原邮件与AI分析双栏；
- [ ] 一封达人回复能生成中文摘要和报价提取；
- [ ] 匹配成功的邮件能把AI字段写回飞书；
- [ ] 页面和日志中不显示`OPENAI_API_KEY`；
- [ ] 管理页不存在草稿编辑和邮件发送入口；
- [ ] 草稿与发送API均返回404；
- [ ] 发送日志不保存邮件正文、明文邮箱密码或明文收件人；
- [ ] 邮件显示规则分类和飞书匹配状态；
- [ ] 错误邮箱可以停用，空邮箱可以安全删除；
- [ ] Render环境存在`MAILBOX_SYNC_INTERVAL_MINUTES=10`；
- [ ] 已启用邮箱能够自动只读同步；
- [ ] 定时任务没有自动发信路径。
