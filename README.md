# Creator BD Agent — Phase 1

这是Creator BD Agent的第一阶段后台，只用于验证：

- Render服务可以正常运行；
- 飞书应用可以自动获取`tenant_access_token`；
- 机器人可以向指定测试群发送消息；
- 程序可以读取和更新飞书Base测试记录。

本阶段不会连接真实邮箱，也不会自动发送邮件。

## 安全提醒

如果任何App Secret、Verification Token、Encrypt Key或访问Token曾经出现在聊天或日志中，请先在飞书后台重置，再部署本项目。真实值只能填写在Render Environment，不能写入代码或提交到GitHub。

## 接口

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/health` | 无 | Render健康检查，不返回密钥 |
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
| `FEISHU_VERIFICATION_TOKEN` | 否（阶段1） | 后续Webhook校验使用 |
| `FEISHU_ENCRYPT_KEY` | 否（阶段1） | 后续Webhook解密使用 |
| `FEISHU_BASE_APP_TOKEN` | 是 | Wiki节点接口返回的`obj_token` |
| `FEISHU_BASE_TABLE_ID` | 是 | Base网址`table=`后的值 |
| `ADMIN_TOKEN` | 是 | 至少32个随机字符 |
| `PORT` | 否 | 默认3000；Render会自动提供 |

不要保存临时`tenant_access_token`。程序会使用App ID和App Secret自动获取并缓存。

## 本地验证

需要Node.js 22：

```bash
npm ci
npm run check
```

测试使用模拟飞书API，不需要真实密钥，也不会向飞书发送消息。

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
5. 在创建前填入所有标记为`sync: false`的环境变量。
6. `ADMIN_TOKEN`由Render自动生成，也可以自行设置至少32位随机值。
7. 点击部署，等待服务变为`Live`。
8. 打开Render生成的域名加`/health`。

正确结果类似：

```json
{
  "status": "ok",
  "service": "creator-bd-agent",
  "configuration": {
    "feishuCoreConfigured": true,
    "callbackSecurityConfigured": true
  }
}
```

Render免费实例适合当前飞书连接测试；接入IMAP/SMTP邮箱前应升级付费实例，因为免费实例会休眠并限制SMTP常用端口。

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

## 第一阶段验收

- [ ] `npm run check`全部通过；
- [ ] GitHub仓库为Private；
- [ ] GitHub中没有真实密钥；
- [ ] Render服务为`Live`；
- [ ] `/health`返回200且不泄露密钥；
- [ ] 测试群收到机器人消息；
- [ ] 程序能列出Base记录；
- [ ] 程序能更新`API测试记录`；
- [ ] 所有写接口都需要`ADMIN_TOKEN`；
- [ ] 未连接真实邮箱；
- [ ] 未开启自动发信。

