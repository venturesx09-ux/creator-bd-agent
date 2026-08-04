export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Creator BD Agent 工作台</title>
  <link rel="stylesheet" href="/admin/styles.css">
</head>
<body>
  <main>
    <header>
      <div>
        <p class="eyebrow">CREATOR BD AGENT</p>
        <h1>Creator BD工作台</h1>
        <p class="muted">自动只读同步、匹配飞书并生成AI中文摘要与英文回复草稿；不会发送邮件。</p>
      </div>
      <span class="badge">AI ASSISTED</span>
    </header>

    <section class="panel" id="login-panel">
      <h2>管理员验证</h2>
      <p class="muted">输入Render中的ADMIN_TOKEN。Token仅保存在当前浏览器标签会话中，页面刷新后仍可继续使用，关闭标签后清除。</p>
      <div class="row">
        <input id="admin-token" type="password" autocomplete="off" placeholder="ADMIN_TOKEN">
        <button id="connect-button" type="button">进入管理</button>
      </div>
    </section>

    <section id="workspace" hidden>
      <section class="panel">
        <div class="section-heading">
          <div><h2>过去24小时</h2><p class="muted">规则分类与飞书达人匹配概览。</p></div>
          <div class="heading-actions"><button id="refresh-summary" class="secondary" type="button">刷新概览</button><button id="logout-button" class="secondary" type="button">退出</button><span class="badge light">AUTO SYNC</span></div>
        </div>
        <div id="summary-grid" class="summary-grid"></div>
      </section>

      <section class="panel" id="feishu-progress-panel">
        <div class="section-heading">
          <div><h2>飞书匹配与写回</h2><p class="muted" id="feishu-index-text">等待后台任务。</p></div>
          <div class="heading-actions"><button id="refresh-feishu-index" class="secondary" type="button">立即刷新飞书索引</button><span class="badge light" id="feishu-progress-status">空闲</span></div>
        </div>
        <div class="progress-panel always-visible">
          <div class="progress-line"><strong id="feishu-progress-text">暂无待处理邮件</strong><span id="feishu-progress-value">0%</span></div>
          <progress id="feishu-progress-bar" value="0" max="100"></progress>
        </div>
        <div class="progress-stats">
          <div><strong id="feishu-total">0</strong><span>本轮任务</span></div>
          <div><strong id="feishu-processed">0</strong><span>已处理</span></div>
          <div><strong id="feishu-matched">0</strong><span>匹配成功</span></div>
          <div><strong id="feishu-unmatched">0</strong><span>未匹配</span></div>
          <div><strong id="feishu-written">0</strong><span>写回成功</span></div>
          <div><strong id="feishu-failed">0</strong><span>失败</span></div>
        </div>
        <p class="muted progress-updated" id="feishu-progress-updated">页面每2秒自动更新。</p>
      </section>

      <section class="panel">
        <div class="section-heading">
          <div><h2>已连接邮箱</h2><p class="muted">密码不会显示，也不会写入日志。</p></div>
          <div class="heading-actions"><button id="sync-all-button" type="button">全部同步</button><button id="refresh-button" class="secondary" type="button">刷新邮箱</button></div>
        </div>
        <div id="sync-progress" class="progress-panel" hidden>
          <div class="progress-line"><strong id="sync-progress-text">准备同步</strong><span id="sync-progress-value">0%</span></div>
          <progress id="sync-progress-bar" value="0" max="100"></progress>
          <p class="muted">这里显示邮箱读取进度；飞书匹配和写回会在后台继续执行。</p>
        </div>
        <div id="mailbox-list" class="cards"></div>
      </section>

      <section class="panel">
        <h2>添加邮箱</h2>
        <form id="mailbox-form">
          <div class="grid">
            <label>邮箱名称<input name="label" required maxlength="80" placeholder="例如 Tripo工作邮箱"></label>
            <label>对应项目<input name="brand" maxlength="80" placeholder="例如 Tripo"></label>
            <label>邮箱地址<input name="emailAddress" type="email" required maxlength="254"></label>
            <label>发件人名称<input name="senderName" required maxlength="100"></label>
            <label>IMAP服务器<input name="imapHost" required maxlength="253" placeholder="imap.example.com"></label>
            <label>IMAP端口<select name="imapPort"><option value="993">993</option><option value="143">143</option></select></label>
            <label>加密方式<select name="imapSecurity"><option value="tls">SSL/TLS</option><option value="starttls">STARTTLS</option></select></label>
            <label>收件箱名称<input name="inboxName" value="INBOX" maxlength="128"></label>
            <label>IMAP用户名<input name="imapUsername" required maxlength="254" autocomplete="username"></label>
            <label>邮箱密码/应用专用密码<input name="imapPassword" type="password" required maxlength="2048" autocomplete="new-password"></label>
          </div>
          <button type="submit">加密保存邮箱</button>
        </form>
      </section>

      <section class="panel" id="message-panel" hidden>
        <div class="section-heading">
          <div><h2 id="message-title">最近邮件</h2><p class="muted">左侧查看原邮件，右侧查看AI分析和飞书写回状态；草稿不会自动发送。</p></div>
          <div class="heading-actions"><button id="refresh-messages" class="secondary" type="button">刷新邮件</button><button id="close-messages" class="secondary" type="button">关闭</button></div>
        </div>
        <div id="message-list" class="messages"></div>
      </section>
    </section>

    <div id="status" role="status" aria-live="polite"></div>
  </main>
  <script src="/admin/app.js" defer></script>
</body>
</html>`;

export const ADMIN_CSS = `:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171717;background:#f5f5f3}*{box-sizing:border-box}body{margin:0}main{width:min(1040px,calc(100% - 32px));margin:40px auto 80px}header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px}h1{font-size:38px;letter-spacing:-.04em;margin:4px 0 8px}h2{font-size:20px;margin:0 0 8px}.eyebrow{font-size:12px;letter-spacing:.18em;font-weight:700;margin:0}.muted{color:#696969;margin:0;line-height:1.55}.badge{font-size:11px;font-weight:700;letter-spacing:.12em;background:#181818;color:white;padding:8px 12px;border-radius:999px}.badge.light{background:#edf8f0;color:#147a39}.panel{background:#fff;border:1px solid #e6e6e1;border-radius:18px;padding:24px;margin-bottom:18px;box-shadow:0 10px 30px rgba(0,0,0,.035)}.row,.section-heading,.heading-actions,.progress-line{display:flex;gap:12px;align-items:center}.section-heading,.progress-line{justify-content:space-between}.section-heading{margin-bottom:18px}.heading-actions{flex-wrap:wrap;justify-content:flex-end}.row{margin-top:16px}.row input{flex:1}.summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.summary-item{background:#f7f7f4;border-radius:12px;padding:14px}.summary-value{font-size:26px;font-weight:750;display:block}.summary-label{font-size:12px;color:#696969}.progress-panel{background:#f7f7f4;border:1px solid #e8e8e3;border-radius:12px;padding:14px;margin-bottom:16px}.progress-panel.always-visible{margin-bottom:12px}.progress-panel progress{width:100%;height:12px;margin:10px 0 6px;accent-color:#147a39}.progress-stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}.progress-stats div{background:#f7f7f4;border-radius:10px;padding:12px}.progress-stats strong{display:block;font-size:22px}.progress-stats span{font-size:11px;color:#696969}.progress-updated{margin-top:12px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px;margin:18px 0}label{display:grid;gap:7px;font-size:13px;font-weight:650}input,select,button{font:inherit;border-radius:10px}input,select{width:100%;border:1px solid #d8d8d2;padding:11px 12px;background:white}input:focus,select:focus{outline:2px solid #171717;outline-offset:1px}button{border:1px solid #171717;background:#171717;color:white;padding:11px 16px;font-weight:700;cursor:pointer}button:disabled{opacity:.5;cursor:wait}button.secondary{background:white;color:#171717;border-color:#d8d8d2}button.danger{color:#b42318;border-color:#efc7c3}.cards{display:grid;gap:12px}.mailbox{border:1px solid #e8e8e3;border-radius:14px;padding:16px}.mailbox.disabled{opacity:.65;background:#fafaf8}.mailbox-top{display:flex;justify-content:space-between;gap:16px}.mailbox h3{margin:0 0 5px;font-size:16px}.meta{font-size:13px;color:#676767;line-height:1.6}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.actions button{font-size:13px;padding:8px 11px}.state{font-size:12px;font-weight:700}.state.success{color:#147a39}.state.failed,.state.disabled{color:#b42318}.messages{display:grid;gap:10px}.message{border-top:1px solid #ecece7;padding-top:14px}.message:first-child{border-top:0}.message h3{font-size:15px;margin:0 0 6px}.message p{font-size:13px;color:#555;white-space:pre-wrap;margin:4px 0;line-height:1.5}.pill{display:inline-block;font-size:11px;font-weight:700;background:#f0f0eb;border-radius:999px;padding:5px 8px;margin:2px 6px 5px 0}#status{position:fixed;right:20px;bottom:20px;max-width:420px;background:#171717;color:#fff;border-radius:12px;padding:12px 16px;opacity:0;transform:translateY(8px);transition:.2s;pointer-events:none}#status.show{opacity:1;transform:none}#status.error{background:#a32119}@media(max-width:700px){main{margin-top:24px}.grid{grid-template-columns:1fr}.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.progress-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.row,.section-heading{align-items:stretch;flex-direction:column}.row button{width:100%}.heading-actions{justify-content:flex-start}header{gap:16px}h1{font-size:32px}.panel{padding:18px}}`;

export const ADMIN_CSS_EXTRA = `main{width:min(1180px,calc(100% - 32px))}.messages{gap:14px}.message{border:1px solid #e8e8e3;border-radius:14px;padding:17px;background:#fff}.message:first-child{border-top:1px solid #e8e8e3}.message h3{font-size:16px}.message h4{font-size:13px;margin:0 0 10px}.message-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-top:12px}.message-column{background:#f7f7f4;border-radius:12px;padding:14px;min-width:0}.message-column.ai{background:#f3f7ff;border:1px solid #dae5fb}.message-body{max-height:300px;overflow:auto}.analysis-row{border-top:1px solid rgba(0,0,0,.08);padding-top:8px;margin-top:8px}.analysis-row strong{display:block;font-size:11px;color:#6b6b6b;margin-bottom:3px}.draft{background:#fff;border-radius:9px;padding:10px;border:1px solid #dce5f5;max-height:320px;overflow:auto}.pill.success{background:#eaf7ee;color:#147a39}.pill.failed{background:#fff0ef;color:#a32119}.pill.pending{background:#fff7df;color:#835f00}@media(max-width:760px){.message-columns{grid-template-columns:1fr}}`;

export const ADMIN_JS = `(() => {
  const tokenStorageKey = 'creator-bd-agent-admin-token';
  let adminToken = window.sessionStorage.getItem(tokenStorageKey) || '';
  let currentMailboxes = [];
  let currentMessageMailbox = null;
  let progressTimer = null;
  let progressRequestRunning = false;
  let lastProgressStatus = 'idle';
  const byId = (id) => document.getElementById(id);
  const status = byId('status');

  function notify(message, isError = false) {
    status.textContent = message;
    status.className = 'show' + (isError ? ' error' : '');
    window.setTimeout(() => { status.className = ''; }, 4200);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        'Authorization': 'Bearer ' + adminToken,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        window.sessionStorage.removeItem(tokenStorageKey);
        adminToken = '';
        stopProgressPolling();
        byId('workspace').hidden = true;
        byId('login-panel').hidden = false;
      }
      throw new Error(data.message || data.error || '请求失败');
    }
    return data;
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, action) {
    const node = element('button', text, 'secondary');
    node.type = 'button';
    node.addEventListener('click', async () => {
      node.disabled = true;
      try { await action(); } catch (error) { notify(error.message, true); }
      finally { node.disabled = false; }
    });
    return node;
  }

  async function loadMailboxes() {
    const [data, summary] = await Promise.all([
      api('/api/admin/mailboxes'),
      api('/api/admin/daily-summary')
    ]);
    renderSummary(summary);
    currentMailboxes = data.mailboxes;
    const list = byId('mailbox-list');
    list.replaceChildren();
    if (!data.mailboxes.length) {
      list.append(element('p', '还没有邮箱，请在下方添加第一个试点邮箱。', 'muted'));
      return;
    }
    data.mailboxes.forEach((mailbox) => {
      const card = element('article', undefined, 'mailbox' + (mailbox.enabled ? '' : ' disabled'));
      const top = element('div', undefined, 'mailbox-top');
      const info = element('div');
      info.append(element('h3', mailbox.label));
      info.append(element('div', mailbox.emailAddress + (mailbox.brand ? ' · ' + mailbox.brand : ''), 'meta'));
      info.append(element('div', mailbox.imapHost + ':' + mailbox.imapPort + ' · ' + mailbox.imapSecurity.toUpperCase(), 'meta'));
      const stateText = !mailbox.enabled ? '已停用' : mailbox.lastTestStatus === 'success' ? '连接正常' : mailbox.lastTestStatus === 'failed' ? '连接失败' : '未测试';
      top.append(info, element('span', stateText, 'state ' + (!mailbox.enabled ? 'disabled' : (mailbox.lastTestStatus || ''))));
      const actions = element('div', undefined, 'actions');
      actions.append(
        button('测试IMAP', async () => {
          const result = await api('/api/admin/mailboxes/' + mailbox.id + '/test', { method: 'POST' });
          notify('连接成功，收件箱共 ' + result.messagesInInbox + ' 封邮件');
          await loadMailboxes();
        }),
        button('只读同步', async () => {
          const result = await api('/api/admin/mailboxes/' + mailbox.id + '/sync', { method: 'POST' });
          notify('同步完成：读取 ' + result.fetched + '，新增 ' + result.inserted + '。飞书匹配正在后台进行，请稍后刷新');
          await loadMessages(mailbox.id, mailbox.label);
          await loadMailboxes();
        }),
        button('查看最近邮件', async () => {
          await loadMessages(mailbox.id, mailbox.label);
        }),
        button(mailbox.enabled ? '停用' : '启用', async () => {
          await api('/api/admin/mailboxes/' + mailbox.id + '/status', {
            method: 'PATCH', body: JSON.stringify({ enabled: !mailbox.enabled })
          });
          notify(mailbox.enabled ? '邮箱已停用' : '邮箱已启用');
          await loadMailboxes();
        }),
        button('删除', async () => {
          if (!window.confirm('仅空邮箱可以删除。确认删除这个邮箱配置？')) return;
          await api('/api/admin/mailboxes/' + mailbox.id, { method: 'DELETE' });
          notify('邮箱配置已删除');
          await loadMailboxes();
        })
      );
      actions.lastElementChild.classList.add('danger');
      card.append(top, actions);
      list.append(card);
    });
  }

  async function loadSummary() {
    renderSummary(await api('/api/admin/daily-summary'));
  }

  function renderFeishuProgress(progress) {
    const messages = progress.messages;
    const percentage = messages.total
      ? Math.min(100, Math.round(messages.processed * 100 / messages.total))
      : 0;
    const statusLabels = {
      idle: '空闲', processing: '处理中', completed: '已完成',
      completed_with_errors: '部分失败', failed: '处理失败'
    };
    const indexLabels = {
      idle: '等待建立飞书索引', loading: '正在扫描飞书Base',
      refreshing: '正在后台刷新飞书索引', ready: '飞书索引已就绪',
      failed: '飞书索引读取失败'
    };
    const source = progress.index.source === 'database' ? '数据库邮箱索引项' : '飞书Base记录';
    const indexCount = progress.index.total
      ? progress.index.loaded + ' / ' + progress.index.total
      : String(progress.index.loaded || 0);
    byId('feishu-progress-status').textContent = statusLabels[progress.status] || '未知';
    byId('feishu-index-text').textContent = (indexLabels[progress.index.status] || '索引状态未知') +
      (progress.index.status === 'idle' ? '' : ' · ' + source + ' · ' + indexCount + ' 项');
    byId('feishu-progress-bar').value = percentage;
    byId('feishu-progress-value').textContent = percentage + '%';
    byId('feishu-progress-text').textContent = messages.total
      ? '正在处理：' + messages.processed + ' / ' + messages.total
      : '暂无待处理邮件';
    byId('feishu-total').textContent = String(messages.total);
    byId('feishu-processed').textContent = String(messages.processed);
    byId('feishu-matched').textContent = String(messages.matched);
    byId('feishu-unmatched').textContent = String(messages.unmatched);
    byId('feishu-written').textContent = String(messages.writebackSucceeded);
    byId('feishu-failed').textContent = String(messages.failed);
    byId('feishu-progress-updated').textContent = '最后更新：' +
      new Date(progress.updatedAt).toLocaleTimeString() + ' · 页面每2秒自动更新';
  }

  async function loadFeishuProgress() {
    if (progressRequestRunning || !adminToken) return;
    progressRequestRunning = true;
    try {
      const progress = await api('/api/admin/feishu/progress');
      renderFeishuProgress(progress);
      if (lastProgressStatus === 'processing' &&
          (progress.status === 'completed' || progress.status === 'completed_with_errors')) {
        await loadSummary();
      }
      lastProgressStatus = progress.status;
    } finally {
      progressRequestRunning = false;
    }
  }

  function startProgressPolling() {
    if (progressTimer) return;
    loadFeishuProgress().catch((error) => notify(error.message, true));
    progressTimer = window.setInterval(() => {
      loadFeishuProgress().catch((error) => notify(error.message, true));
    }, 2000);
  }

  function stopProgressPolling() {
    if (progressTimer) window.clearInterval(progressTimer);
    progressTimer = null;
    progressRequestRunning = false;
  }

  async function loadMessages(mailboxId, label) {
    const result = await api('/api/admin/mailboxes/' + mailboxId + '/messages?limit=100');
    currentMessageMailbox = { id: mailboxId, label: label };
    showMessages(mailboxId, label, result.messages);
  }

  function updateProgress(done, total, message) {
    const percentage = total ? Math.round(done * 100 / total) : 100;
    byId('sync-progress').hidden = false;
    byId('sync-progress-bar').value = percentage;
    byId('sync-progress-value').textContent = percentage + '%';
    byId('sync-progress-text').textContent = message;
  }

  async function syncAllMailboxes() {
    const enabled = currentMailboxes.filter((mailbox) => mailbox.enabled);
    if (!enabled.length) return notify('没有已启用邮箱', true);
    let succeeded = 0;
    let failed = 0;
    updateProgress(0, enabled.length, '准备同步 ' + enabled.length + ' 个邮箱');
    for (let index = 0; index < enabled.length; index += 1) {
      const mailbox = enabled[index];
      updateProgress(index, enabled.length, '正在同步：' + mailbox.label);
      try {
        let hasMore = true;
        while (hasMore) {
          const result = await api('/api/admin/mailboxes/' + mailbox.id + '/sync', { method: 'POST' });
          hasMore = result.hasMore;
        }
        succeeded += 1;
      } catch (_error) {
        failed += 1;
      }
      updateProgress(index + 1, enabled.length, '已完成：' + mailbox.label);
    }
    await loadMailboxes();
    notify('全部同步完成：成功 ' + succeeded + '，失败 ' + failed + '。飞书匹配正在后台继续');
  }

  function renderSummary(summary) {
    const values = [
      ['邮件总数', summary.total],
      ['达人回复', summary.classifications.creator_reply],
      ['退信/自动/通知', summary.classifications.delivery_failure + summary.classifications.automatic_reply + summary.classifications.bulk_notification],
      ['已匹配邮件', summary.matched],
      ['唯一匹配达人', summary.uniqueMatchedCreators],
      ['重复回复邮件', summary.duplicateMatchedMessages],
      ['未匹配邮件', summary.unmatched],
      ['等待处理', summary.pending]
    ];
    const grid = byId('summary-grid');
    grid.replaceChildren();
    values.forEach(([label, value]) => {
      const item = element('div', undefined, 'summary-item');
      item.append(element('span', String(value), 'summary-value'), element('span', label, 'summary-label'));
      grid.append(item);
    });
  }

  const classificationLabels = {
    creator_reply: '达人回复', automatic_reply: '自动回复',
    delivery_failure: '退信', bulk_notification: '批量/通知', unknown: '未知'
  };

  const matchReasonLabels = {
    email_exact: '通过发件邮箱匹配',
    history_creator_id: '通过历史达人ID匹配',
    history_creator_id_missing: '历史邮件中未找到Hi + 达人ID',
    creator_id_not_found: '历史达人ID在飞书中不存在',
    creator_id_ambiguous: '达人ID重复，无法唯一匹配'
  };

  const aiStatusLabels = {
    pending: '等待AI分析', completed: 'AI分析完成',
    failed: 'AI分析失败', skipped: '尚未分析'
  };

  const replyTypeLabels = {
    interested_with_quote: '感兴趣并报价',
    interested_without_quote: '感兴趣未报价',
    counteroffer: '还价/议价', declined: '拒绝合作',
    manager_reply: '经纪人回复', needs_clarification: '需要澄清',
    unrelated: '非达人回复'
  };

  const actionLabels = {
    review_quote: '审核报价', ask_for_quote: '询问报价',
    answer_questions: '回答问题', clarify_requirements: '澄清合作要求',
    close_as_declined: '记录拒绝', manual_review: '人工判断'
  };

  function analysisRow(parent, label, value, className) {
    if (value === null || value === undefined || value === '' ||
        (Array.isArray(value) && !value.length)) return;
    const row = element('div', undefined, 'analysis-row' + (className ? ' ' + className : ''));
    row.append(element('strong', label));
    row.append(element('p', Array.isArray(value) ? value.join('；') : String(value)));
    parent.append(row);
  }

  function showMessages(mailboxId, label, messages) {
    byId('message-title').textContent = label + ' · 最近邮件';
    const list = byId('message-list');
    list.replaceChildren();
    if (!messages.length) list.append(element('p', '暂无已同步邮件。', 'muted'));
    messages.forEach((message) => {
      const card = element('article', undefined, 'message');
      card.append(element('h3', message.subject || '(无主题)'));
      card.append(element('span', classificationLabels[message.classification] || '未知', 'pill'));
      card.append(element('span', message.matchStatus === 'matched' ? '已匹配飞书' : message.matchStatus === 'unmatched' ? '未匹配飞书' : '等待匹配', 'pill'));
      if (message.matchReason) card.append(element('span', matchReasonLabels[message.matchReason] || message.matchReason, 'pill'));
      const aiState = message.aiAnalysisStatus || 'skipped';
      const aiClass = aiState === 'completed' ? 'success' : aiState === 'failed' ? 'failed' : 'pending';
      card.append(element('span', aiStatusLabels[aiState] || aiState, 'pill ' + aiClass));

      const columns = element('div', undefined, 'message-columns');
      const original = element('section', undefined, 'message-column');
      original.append(element('h4', '原邮件'));
      original.append(element('p', '来自：' + (message.from.join(', ') || '未知')));
      if (message.receivedAt) original.append(element('p', new Date(message.receivedAt).toLocaleString()));
      if (message.textPreview) original.append(element('p', message.textPreview.slice(0, 3000), 'message-body'));

      const ai = element('section', undefined, 'message-column ai');
      ai.append(element('h4', 'AI分析（仅供人工确认）'));
      const analysis = message.analysis;
      if (analysis) {
        analysisRow(ai, '中文摘要', analysis.summaryZh);
        analysisRow(ai, '回复类型', replyTypeLabels[analysis.replyType] || analysis.replyType);
        analysisRow(ai, '报价', analysis.quotedAmount === null ? '未识别到报价' : analysis.currency + ' ' + analysis.quotedAmount);
        analysisRow(ai, '交付内容', analysis.deliverables);
        analysisRow(ai, '时间/档期', analysis.timeline);
        analysisRow(ai, '权益要求', analysis.rightsRequests);
        analysisRow(ai, '付款要求', analysis.paymentRequests);
        analysisRow(ai, '风险提示', analysis.riskFlags);
        analysisRow(ai, '建议动作', actionLabels[analysis.recommendedAction] || analysis.recommendedAction);
        analysisRow(ai, '英文回复草稿', analysis.replyDraftEn, 'draft');
        analysisRow(ai, '飞书AI字段', message.aiBaseSyncStatus === 'synced' ? '已写回' : message.matchedRecordId ? '等待写回/写回失败' : '未匹配达人，暂不写回');
        if (message.aiAnalyzedAt) analysisRow(ai, '分析时间', new Date(message.aiAnalyzedAt).toLocaleString());
      } else {
        const reason = aiState === 'failed'
          ? '上次分析失败：' + (message.aiErrorCode || '请稍后重试')
          : message.classification === 'creator_reply'
            ? '点击下方按钮生成中文摘要和英文回复草稿。'
            : '仅达人回复会进入AI分析。';
        ai.append(element('p', reason, 'muted'));
      }
      columns.append(original, ai);
      card.append(columns);

      if (message.classification === 'creator_reply') {
        const actions = element('div', undefined, 'actions');
        actions.append(button(analysis ? '重新分析' : 'AI分析', async () => {
          await api('/api/admin/mailboxes/' + mailboxId + '/messages/' + message.id + '/analyze', { method: 'POST' });
          notify('AI分析已完成；如已匹配达人，系统也已尝试写回飞书');
          await loadMessages(mailboxId, label);
        }));
        card.append(actions);
      }
      list.append(card);
    });
    byId('message-panel').hidden = false;
    byId('message-panel').scrollIntoView({ behavior: 'smooth' });
  }

  byId('connect-button').addEventListener('click', async () => {
    adminToken = byId('admin-token').value.trim();
    if (!adminToken) return notify('请输入ADMIN_TOKEN', true);
    try {
      await loadMailboxes();
      window.sessionStorage.setItem(tokenStorageKey, adminToken);
      byId('admin-token').value = '';
      byId('login-panel').hidden = true;
      byId('workspace').hidden = false;
      startProgressPolling();
      notify('管理员验证成功');
    } catch (error) {
      window.sessionStorage.removeItem(tokenStorageKey);
      adminToken = '';
      notify(error.message, true);
    }
  });

  byId('refresh-button').addEventListener('click', () => loadMailboxes().catch((error) => notify(error.message, true)));
  byId('refresh-summary').addEventListener('click', () => loadSummary().then(() => notify('概览已刷新')).catch((error) => notify(error.message, true)));
  byId('refresh-feishu-index').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      const result = await api('/api/admin/feishu/index/refresh', { method: 'POST' });
      notify(result.status === 'started' ? '飞书索引刷新已开始，进度会自动更新' : '飞书索引已经在刷新中');
      await loadFeishuProgress();
    } catch (error) {
      notify(error.message, true);
    } finally {
      event.currentTarget.disabled = false;
    }
  });
  byId('sync-all-button').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try { await syncAllMailboxes(); } finally { event.currentTarget.disabled = false; }
  });
  byId('refresh-messages').addEventListener('click', () => {
    if (!currentMessageMailbox) return;
    loadMessages(currentMessageMailbox.id, currentMessageMailbox.label).then(() => notify('邮件列表已刷新')).catch((error) => notify(error.message, true));
  });
  byId('logout-button').addEventListener('click', () => {
    stopProgressPolling();
    window.sessionStorage.removeItem(tokenStorageKey);
    adminToken = '';
    currentMailboxes = [];
    byId('workspace').hidden = true;
    byId('login-panel').hidden = false;
    notify('已退出当前管理会话');
  });
  byId('close-messages').addEventListener('click', () => { byId('message-panel').hidden = true; });

  byId('mailbox-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    const values = Object.fromEntries(new FormData(form).entries());
    values.imapPort = Number(values.imapPort);
    try {
      await api('/api/admin/mailboxes', { method: 'POST', body: JSON.stringify(values) });
      form.reset();
      form.elements.inboxName.value = 'INBOX';
      form.elements.imapPort.value = '993';
      form.elements.imapSecurity.value = 'tls';
      notify('邮箱已加密保存，请点击测试IMAP');
      await loadMailboxes();
    } catch (error) {
      notify(error.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  if (adminToken) {
    loadMailboxes().then(() => {
      byId('login-panel').hidden = true;
      byId('workspace').hidden = false;
      startProgressPolling();
    }).catch((error) => notify(error.message, true));
  }
})();`;
