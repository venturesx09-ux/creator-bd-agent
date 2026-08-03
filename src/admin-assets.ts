export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Creator BD Agent 邮箱管理</title>
  <link rel="stylesheet" href="/admin/styles.css">
</head>
<body>
  <main>
    <header>
      <div>
        <p class="eyebrow">CREATOR BD AGENT</p>
        <h1>邮箱管理</h1>
        <p class="muted">第二阶段仅使用IMAP只读同步，不会发送邮件。</p>
      </div>
      <span class="badge">READ ONLY</span>
    </header>

    <section class="panel" id="login-panel">
      <h2>管理员验证</h2>
      <p class="muted">输入Render中的ADMIN_TOKEN。Token只保存在当前页面内存，刷新后清除。</p>
      <div class="row">
        <input id="admin-token" type="password" autocomplete="off" placeholder="ADMIN_TOKEN">
        <button id="connect-button" type="button">进入管理</button>
      </div>
    </section>

    <section id="workspace" hidden>
      <section class="panel">
        <div class="section-heading">
          <div><h2>已连接邮箱</h2><p class="muted">密码不会显示，也不会写入日志。</p></div>
          <button id="refresh-button" class="secondary" type="button">刷新</button>
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
          <div><h2 id="message-title">最近邮件</h2><p class="muted">只显示已同步并加密保存的邮件摘要。</p></div>
          <button id="close-messages" class="secondary" type="button">关闭</button>
        </div>
        <div id="message-list" class="messages"></div>
      </section>
    </section>

    <div id="status" role="status" aria-live="polite"></div>
  </main>
  <script src="/admin/app.js" defer></script>
</body>
</html>`;

export const ADMIN_CSS = `:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171717;background:#f5f5f3}*{box-sizing:border-box}body{margin:0}main{width:min(1040px,calc(100% - 32px));margin:40px auto 80px}header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px}h1{font-size:38px;letter-spacing:-.04em;margin:4px 0 8px}h2{font-size:20px;margin:0 0 8px}.eyebrow{font-size:12px;letter-spacing:.18em;font-weight:700;margin:0}.muted{color:#696969;margin:0;line-height:1.55}.badge{font-size:11px;font-weight:700;letter-spacing:.12em;background:#181818;color:white;padding:8px 12px;border-radius:999px}.panel{background:#fff;border:1px solid #e6e6e1;border-radius:18px;padding:24px;margin-bottom:18px;box-shadow:0 10px 30px rgba(0,0,0,.035)}.row,.section-heading{display:flex;gap:12px;align-items:center}.section-heading{justify-content:space-between;margin-bottom:18px}.row{margin-top:16px}.row input{flex:1}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px;margin:18px 0}label{display:grid;gap:7px;font-size:13px;font-weight:650}input,select,button{font:inherit;border-radius:10px}input,select{width:100%;border:1px solid #d8d8d2;padding:11px 12px;background:white}input:focus,select:focus{outline:2px solid #171717;outline-offset:1px}button{border:1px solid #171717;background:#171717;color:white;padding:11px 16px;font-weight:700;cursor:pointer}button:disabled{opacity:.5;cursor:wait}button.secondary{background:white;color:#171717;border-color:#d8d8d2}.cards{display:grid;gap:12px}.mailbox{border:1px solid #e8e8e3;border-radius:14px;padding:16px}.mailbox-top{display:flex;justify-content:space-between;gap:16px}.mailbox h3{margin:0 0 5px;font-size:16px}.meta{font-size:13px;color:#676767;line-height:1.6}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.actions button{font-size:13px;padding:8px 11px}.state{font-size:12px;font-weight:700}.state.success{color:#147a39}.state.failed{color:#b42318}.messages{display:grid;gap:10px}.message{border-top:1px solid #ecece7;padding-top:14px}.message:first-child{border-top:0}.message h3{font-size:15px;margin:0 0 6px}.message p{font-size:13px;color:#555;white-space:pre-wrap;margin:4px 0;line-height:1.5}#status{position:fixed;right:20px;bottom:20px;max-width:420px;background:#171717;color:#fff;border-radius:12px;padding:12px 16px;opacity:0;transform:translateY(8px);transition:.2s;pointer-events:none}#status.show{opacity:1;transform:none}#status.error{background:#a32119}@media(max-width:700px){main{margin-top:24px}.grid{grid-template-columns:1fr}.row{align-items:stretch;flex-direction:column}.row button{width:100%}header{gap:16px}h1{font-size:32px}.panel{padding:18px}}`;

export const ADMIN_JS = `(() => {
  let adminToken = '';
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
    const data = await api('/api/admin/mailboxes');
    const list = byId('mailbox-list');
    list.replaceChildren();
    if (!data.mailboxes.length) {
      list.append(element('p', '还没有邮箱，请在下方添加第一个试点邮箱。', 'muted'));
      return;
    }
    data.mailboxes.forEach((mailbox) => {
      const card = element('article', undefined, 'mailbox');
      const top = element('div', undefined, 'mailbox-top');
      const info = element('div');
      info.append(element('h3', mailbox.label));
      info.append(element('div', mailbox.emailAddress + (mailbox.brand ? ' · ' + mailbox.brand : ''), 'meta'));
      info.append(element('div', mailbox.imapHost + ':' + mailbox.imapPort + ' · ' + mailbox.imapSecurity.toUpperCase(), 'meta'));
      const stateText = mailbox.lastTestStatus === 'success' ? '连接正常' : mailbox.lastTestStatus === 'failed' ? '连接失败' : '未测试';
      top.append(info, element('span', stateText, 'state ' + (mailbox.lastTestStatus || '')));
      const actions = element('div', undefined, 'actions');
      actions.append(
        button('测试IMAP', async () => {
          const result = await api('/api/admin/mailboxes/' + mailbox.id + '/test', { method: 'POST' });
          notify('连接成功，收件箱共 ' + result.messagesInInbox + ' 封邮件');
          await loadMailboxes();
        }),
        button('只读同步', async () => {
          const result = await api('/api/admin/mailboxes/' + mailbox.id + '/sync', { method: 'POST' });
          notify('同步完成：读取 ' + result.fetched + '，新增 ' + result.inserted);
          showMessages(mailbox.id, mailbox.label, result.messages);
          await loadMailboxes();
        }),
        button('查看最近邮件', async () => {
          const result = await api('/api/admin/mailboxes/' + mailbox.id + '/messages?limit=20');
          showMessages(mailbox.id, mailbox.label, result.messages);
        })
      );
      card.append(top, actions);
      list.append(card);
    });
  }

  function showMessages(_mailboxId, label, messages) {
    byId('message-title').textContent = label + ' · 最近邮件';
    const list = byId('message-list');
    list.replaceChildren();
    if (!messages.length) list.append(element('p', '暂无已同步邮件。', 'muted'));
    messages.forEach((message) => {
      const card = element('article', undefined, 'message');
      card.append(element('h3', message.subject || '(无主题)'));
      card.append(element('p', '来自：' + (message.from.join(', ') || '未知')));
      if (message.receivedAt) card.append(element('p', new Date(message.receivedAt).toLocaleString()));
      if (message.textPreview) card.append(element('p', message.textPreview.slice(0, 500)));
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
      byId('admin-token').value = '';
      byId('login-panel').hidden = true;
      byId('workspace').hidden = false;
      notify('管理员验证成功');
    } catch (error) {
      adminToken = '';
      notify(error.message, true);
    }
  });

  byId('refresh-button').addEventListener('click', () => loadMailboxes().catch((error) => notify(error.message, true)));
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
})();`;
