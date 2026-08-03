# Creator BD Agent — Phase 3.0.3

这是Creator BD Agent的第三阶段后台。在第二阶段全部能力之上新增：

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
- 每10分钟自动同步所有已启用邮箱；
- 邮件规则分类：达人回复、自动回复、退信、批量/系统通知；
- 读取飞书Base并按发件邮箱匹配达人记录；
- 管理页显示过去24小时邮件与匹配概览；
- 邮箱启用、停用以及空邮箱安全删除。
- 支持扫描最多50,000条飞书达人记录，并在同一同步周期缓存邮箱索引。
- 使用完整字段JSON提取嵌套邮箱，并在`total`显示仍有记录时继续分页。

本阶段只读取邮箱，不包含SMTP代码，无法发送邮件。

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
| POST | `/api/admin/mailboxes/:mailboxId/sync` | ADMIN_TOKEN | 手动执行IMAP只读同步 |
| GET | `/api/admin/mailboxes/:mailboxId/messages` | ADMIN_TOKEN | 查看已同步邮件摘要 |
| PATCH | `/api/admin/mailboxes/:mailboxId/status` | ADMIN_TOKEN | 启用或停用邮箱 |
| DELETE | `/api/admin/mailboxes/:mailboxId` | ADMIN_TOKEN | 删除没有同步记录的空邮箱 |
| GET | `/api/admin/daily-summary` | ADMIN_TOKEN | 过去24小时分类与匹配统计 |
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
| `ADMIN_TOKEN` | 是 | 至少32个随机字符 |
| `DATABASE_URL` | 是 | PostgreSQL内部连接地址；Blueprint自动注入 |
| `DATABASE_SSL` | 否 | Render内部数据库连接填写`false` |
| `MAILBOX_ENCRYPTION_KEY` | 是 | 独立的32字节Base64密钥；Blueprint自动生成 |
| `MAILBOX_INITIAL_SYNC_LIMIT` | 否 | 首次同步最近多少封，默认20，最大100 |
| `MAILBOX_SYNC_INTERVAL_MINUTES` | 否 | 自动只读同步间隔，默认10，可设置5至60 |
| `PORT` | 否 | 默认3000；Render会自动提供 |

不要保存临时`tenant_access_token`。程序会使用App ID和App Secret自动获取并缓存。

## 本地验证

需要Node.js 22：

```bash
npm ci
npm run check
```

测试使用模拟飞书API和模拟邮箱服务，不需要真实密钥，不连接真实邮箱，也不会发送消息。

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
7. 对于已经存在的Blueprint，上传3.0代码后在Render的Blueprint页面点击`Sync Blueprint`；
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

免费实例会休眠，休眠期间定时任务不会运行，唤醒后会从上次IMAP UID继续同步。正式持续每10分钟同步需要升级为不会休眠的实例。本阶段没有SMTP发送功能。

## 使用邮箱管理页面

部署成功后打开：

```text
https://你的Render域名/admin
```

1. 从Render Environment复制当前`ADMIN_TOKEN`；
2. 在页面输入Token并点击`进入管理`；
3. 填写邮箱地址、IMAP服务器、端口、加密方式、用户名和应用专用密码；
4. 点击`加密保存邮箱`；
5. 点击`测试IMAP`，确认连接成功；
6. 点击`只读同步`，首次只读取最近20封邮件；
7. 点击`查看最近邮件`检查主题、发件人和正文预览。
8. 查看顶部“过去24小时”，确认分类和飞书匹配数量；
9. 错误的重复邮箱可点击`停用`；若从未同步过邮件，可点击`删除`。

支持两种强制加密连接：

- 端口993 + SSL/TLS；
- 端口143 + STARTTLS。

系统使用IMAP只读模式打开`INBOX`，不会修改已读状态、移动或删除邮件。每次最多处理100封；自动任务会继续处理后续批次。邮箱停用后不会再自动或手动同步，但历史邮件仍会保留。

## 第三阶段分类与飞书匹配

分类使用确定性规则，不调用AI：

- `达人回复`：普通外部联系人回复；
- `自动回复`：识别Auto-Submitted、Automatic Reply、Out of Office等；
- `退信`：识别Mailer-Daemon、Postmaster及投递失败主题；
- `批量/通知`：识别Precedence、List-ID和no-reply等。

每次同步后，程序只读取飞书Base记录，将邮件发件邮箱与Base各字段中出现的邮箱做不区分大小写的精确匹配。升级前同步的旧邮件也会自动补分类和重新匹配；未匹配邮件会在后续同步时重试。经纪人回复需要把经纪人邮箱也保存到对应达人记录中。匹配结果仅写入本项目数据库，不会修改飞书Base。业务含义分类（感兴趣、报价、拒绝等）留到第四阶段接入AI后处理。

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

## 第三阶段验收

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
- [ ] `/health`显示版本`3.0.3`；
- [ ] 管理页顶部显示过去24小时摘要；
- [ ] 邮件显示规则分类和飞书匹配状态；
- [ ] 错误邮箱可以停用，空邮箱可以安全删除；
- [ ] Render环境存在`MAILBOX_SYNC_INTERVAL_MINUTES=10`；
- [ ] 已启用邮箱能够自动只读同步；
- [ ] 未开启自动发信。
