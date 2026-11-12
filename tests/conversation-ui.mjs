import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

assert.equal(typeof WebSocket, 'function', '浏览器回归测试需要 Node.js 22 或更新版本');
const profile = await mkdtemp(join(tmpdir(), 'codearts-chat-test-'));
const chrome = spawn(process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank',
]);
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    chrome.stderr.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    chrome.on('error', reject);
    chrome.on('exit', (code) => reject(new Error(`Chrome exited: ${code}`)));
  });
  const origin = endpoint.replace(/^ws:/, 'http:').split('/devtools/')[0];
  const pages = await (await fetch(`${origin}/json/list`)).json();
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(message.error);
      else request.resolve(message.result);
    }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression: typeof expression === 'function' ? `(${expression.toString()})()` : expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 100; i++) {
      const check = typeof expression === 'function' ? `Boolean((${expression.toString()})())` : `Boolean(${expression})`;
      if (await evaluate(check)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${expression}`);
  };
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `${process.env.PREVIEW_URL ?? 'http://localhost:1430'}/preview-setup.html?state=tools` });
  await wait(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('进入工作区')));
  await evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('进入工作区')).click());
  await wait(() => document.querySelectorAll('.sess button.link').length >= 2);
  await evaluate(() => document.querySelector('.sess button.link').click());
  await wait(() => document.querySelector('.toolrun'));
  await evaluate(() => [...document.querySelectorAll('.frow.file')].find((b) => b.textContent.includes('CHANGELOG.md')).click());
  await wait(() => document.querySelector('.fileview [aria-label="编辑文件"]'));
  assert.equal(await evaluate(() => document.querySelectorAll('.fvedit').length), 0);
  await evaluate(() => document.querySelector('.fileview [aria-label="编辑文件"]').click());
  await wait(() => document.querySelector('.fvedit'));
  await evaluate(() => {
    const ta = document.querySelector('.fvedit');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ta.value + '\n\n编辑器新增一行。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(() => !!document.querySelector('.fvdirty'));
  const editorShot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(tmpdir(), 'codearts-editor-ui.png'), Buffer.from(editorShot.data, 'base64'));
  await evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })));
  await wait(() => !document.querySelector('.fvdirty') && document.querySelector('.fhint')?.textContent === '已保存');
  assert.ok(await evaluate(() => Object.entries(window.__fileMtimes).some(([k, v]) => k.endsWith('CHANGELOG.md') && v > 0)));
  console.log('PASS 资源管理器编辑与 ⌘S 保存');

  await evaluate(() => {
    const ta = document.querySelector('.fvedit');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ta.value + '\n\n第二次修改。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const key = Object.keys(window.__fileMtimes).find((k) => k.endsWith('CHANGELOG.md'));
    window.__fileMtimes[key] += 1;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }));
  });
  await wait(() => !!document.querySelector('.fvbar.warn'));
  assert.ok(await evaluate(() => document.querySelector('.fvbar.warn').textContent.includes('已被修改')));
  await evaluate(() => [...document.querySelectorAll('.fvbar.warn button')].find((b) => b.textContent.includes('覆盖保存')).click());
  await wait(() => !document.querySelector('.fvbar.warn') && !document.querySelector('.fvdirty'));
  console.log('PASS 磁盘冲突提示与覆盖保存');

  await evaluate(() => {
    const ta = document.querySelector('.fvedit');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ta.value + '\n\n未保存的改动。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await wait(() => [...document.querySelectorAll('.fvbar button')].some((b) => b.textContent.includes('保存并退出编辑')));
  await evaluate(() => [...document.querySelectorAll('.fvbar button')].find((b) => b.textContent.includes('放弃修改')).click());
  await wait(() => !document.querySelector('.fvedit'));
  await evaluate(() => document.querySelector('.fileview [aria-label="关闭预览"]').click());
  await wait(() => !document.querySelector('.fileview'));
  console.log('PASS 未保存退出确认与关闭');
  assert.equal(await evaluate(() => document.querySelectorAll('.tgbody').length), 0);
  await evaluate(() => document.querySelector('.toolrun > summary').click());
  await wait(() => document.querySelector('.tgrow'));
  assert.equal(await evaluate(() => document.querySelectorAll('.tgbody').length), 0);
  await evaluate(() => document.querySelector('.tgrow .tgr > summary').click());
  await wait(() => document.querySelectorAll('.tgbody').length === 1);
  console.log('PASS 工具卡及详情仅在点击时加载');

  await evaluate(async () => {
    const { applyMessageEvents } = await import('/src/messageState.ts');
    window.__fixture = [];
    window.__sendEvent = (type, properties) => {
      window.__fixture = applyMessageEvents(window.__fixture, [{ type, properties }]);
      window.__emit(type, properties);
    };
    const sid = 'ses_a1';
    const prose = '这是一段用来验证长会话滚动稳定性的正文。'.repeat(24);
    for (let i = 0; i < 250; i++) {
      const user = `u-${i}`, assistant = `a-${i}`;
      const info = (id, role) => ({ id, role, sessionID: sid, time: { created: 1000 + i * 10, completed: 1010 + i * 10 } });
      const userInfo = i === 249 ? {
        ...info(user, 'user'),
        summary: { additions: 12, deletions: 3, files: 3, diffs: [
          { file: '/tmp/a.ts', status: 'modified', additions: 7, deletions: 2 },
          { file: '/tmp/b.ts', status: 'added', additions: 5, deletions: 0 },
          { file: '/tmp/c.ts', status: 'modified', additions: 0, deletions: 1 },
        ] },
      } : info(user, 'user');
      window.__fixture.push({ info: userInfo, parts: [{ id: `pu-${i}`, messageID: user, sessionID: sid, type: 'text', text: `第 ${i + 1} 轮：检查会话交互。` }] });
      const parts = [{ id: `pa-${i}`, messageID: assistant, sessionID: sid, type: 'text', text: `## 第 ${i + 1} 轮回复\n\n${prose}\n\n- [x] 已完成检查\n- [ ] 待验证\n\n| 场景 | 结果 |\n| --- | --- |\n| 滚动 | 稳定 |\n\n\`\`\`ts\nconst result = "完整正文";\n\`\`\`` }];
      if (i === 249) for (let j = 0; j < 80; j++) parts.push({ id: `tool-${j}`, messageID: assistant, sessionID: sid, type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: `test-command-${j}` }, metadata: { preview: '截断预览' }, output: `完整输出 ${j}\n` + '日志行\n'.repeat(300) + '输出末尾标记' } });
      window.__fixture.push({ info: info(assistant, 'assistant'), parts });
    }
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'api_request' && args.method === 'GET' && args.path === '/session/ses_a1/message') {
        const snapshot = structuredClone(window.__fixture);
        if (window.__holdSnapshot) await new Promise((resolve) => { window.__releaseSnapshot = resolve; });
        return snapshot;
      }
      return invoke(cmd, args);
    };
    document.querySelectorAll('.sess button.link')[1].click();
  });
  await wait(() => document.querySelectorAll('.conversation-turn').length === 0);
  await evaluate(() => document.querySelector('.sess button.link').click());
  await wait(() => document.querySelectorAll('.conversation-turn').length === 250);
  await wait(() => { const el = document.querySelector('.thread'); return el.scrollHeight - el.scrollTop - el.clientHeight < 3; });
  const initial = await evaluate(() => ({ mounted: document.querySelectorAll('.conversation-turn[data-mounted="true"]').length, nodes: document.querySelectorAll('.thread *').length, total: document.querySelectorAll('.conversation-turn').length }));
  assert.ok(initial.mounted < 15, JSON.stringify(initial));
  assert.ok(initial.nodes < 2500, JSON.stringify(initial));
  const summaryWidth = await evaluate(() => {
    const summary = [...document.querySelectorAll('.turnsum')].at(-1);
    return { turnsum: summary?.offsetWidth ?? 0, content: document.querySelector('.thread-content').clientWidth };
  });
  assert.ok(summaryWidth.turnsum >= summaryWidth.content - 2, JSON.stringify(summaryWidth));
  console.log('PASS 长会话窗口化与轮末改动铺满宽度', initial, summaryWidth);

  const position = await evaluate(() => { const b = document.querySelector('.thread').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...position, deltaX: 0, deltaY: -30 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(await evaluate(() => !!document.querySelector('.jump-latest')), false);
  await call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...position, deltaX: 0, deltaY: -140 });
  await wait(() => !!document.querySelector('.jump-latest'));
  const readingTop = await evaluate(() => document.querySelector('.thread').scrollTop);
  await evaluate(async () => {
    const sid = 'ses_a1', mid = 'streaming', pid = 'stream-text';
    window.__emit('session.status', { sessionID: sid, status: { type: 'busy' } });
    window.__sendEvent('message.updated', { info: { id: mid, sessionID: sid, role: 'assistant', time: { created: Date.now() } } });
    window.__sendEvent('message.part.updated', { part: { id: pid, sessionID: sid, messageID: mid, type: 'text', text: '' } });
    let text = '';
    for (let i = 0; i < 20; i++) {
      const delta = `连续输出 ${i}，界面不得抢夺滚动位置。\n`;
      text += delta;
      window.__sendEvent('message.part.delta', { sessionID: sid, messageID: mid, partID: pid, field: 'text', delta });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    window.__sendEvent('message.part.updated', { part: { id: pid, sessionID: sid, messageID: mid, type: 'text', text, time: { end: Date.now() } } });
    window.__expectedText = text;
    window.__emit('session.status', { sessionID: sid, status: { type: 'idle' } });
  });
  await wait(() => document.querySelector('.thread').innerText.includes('连续输出 19'));
  const drift = Math.abs((await evaluate(() => document.querySelector('.thread').scrollTop)) - readingTop);
  assert.ok(drift <= 3, `上翻后流式输出漂移 ${drift}px`);
  assert.equal(await evaluate(() => (document.querySelector('.thread').innerText.match(/连续输出 19/g) ?? []).length), 1);
  console.log('PASS 上翻30px不提示、140px暂停跟随，连续输出无重复，位置漂移', drift);
  await evaluate(() => document.querySelector('.jump-latest').click());
  await wait(() => { const el = document.querySelector('.thread'); return !document.querySelector('.jump-latest') && el.scrollHeight - el.scrollTop - el.clientHeight < 3; });

  await evaluate(() => {
    document.querySelector('.toolrun > summary').click();
  });
  await wait(() => document.querySelector('.tgr'));
  await evaluate(() => document.querySelector('.tgr > summary').click());
  await wait(() => document.querySelector('.tgbody')?.textContent.includes('输出末尾标记'));
  assert.ok(await evaluate(() => document.querySelector('.tgbody').textContent.includes('完整输出')));
  await evaluate(() => document.querySelector('.toolrun > summary').click());
  assert.equal(await evaluate(() => document.querySelectorAll('.tgbody').length), 0);
  console.log('PASS 工具详情显示完整输出而非截断预览');
  const cardHeight = await evaluate(() => document.querySelector('.toolrun').getBoundingClientRect().height);
  await evaluate(async () => {
    const part = window.__fixture.find((m) => m.info.id === 'a-249').parts.find((p) => p.id === 'tool-79');
    window.__sendEvent('message.part.updated', { part: { ...part, state: { ...part.state, status: 'running' } } });
    await new Promise((resolve) => setTimeout(resolve, 90));
    window.__sendEvent('message.part.updated', { part: { ...part, state: { ...part.state, status: 'completed', output: '大量工具返回内容\\n'.repeat(20000) } } });
  });
  await wait(() => document.querySelector('.tgstate')?.textContent === '已结束');
  assert.equal(await evaluate(() => document.querySelector('.toolrun').getBoundingClientRect().height), cardHeight);
  assert.equal(await evaluate(() => document.querySelectorAll('.tgbody').length), 0);
  console.log('PASS 工具完成及长输出返回不伸缩卡片或挂载正文');

  await evaluate(() => document.querySelector('.rail button').click());
  await wait(() => document.querySelector('#m-u-0[data-mounted="true"] .msg.user'));
  assert.ok(await evaluate(() => document.querySelector('#m-u-0').getBoundingClientRect().top >= document.querySelector('.thread').getBoundingClientRect().top - 3));
  await evaluate(() => document.querySelector('.rail button:nth-child(126)').click());
  await wait(() => document.querySelector('#m-u-125[data-mounted="true"] .msg.user'));
  assert.ok(await evaluate(() => document.querySelector('#m-u-125').getBoundingClientRect().top >= document.querySelector('.thread').getBoundingClientRect().top - 3));
  console.log('PASS 长会话跳转第1/126轮并挂载正文');
  await evaluate(() => document.querySelector('.jump-latest').click());
  await wait(() => document.querySelector('#m-u-249[data-mounted="true"]'));

  await evaluate(() => {
    window.__holdSnapshot = true;
    window.__bridge('down');
    window.__bridge('open');
  });
  await wait(() => !!window.__releaseSnapshot);
  await evaluate(() => {
    window.__sendEvent('message.updated', { info: { id: 'concurrent', sessionID: 'ses_a1', role: 'assistant', time: { created: Date.now() } } });
    window.__sendEvent('message.part.updated', { part: { id: 'concurrent-text', sessionID: 'ses_a1', messageID: 'concurrent', type: 'text', text: '快照期间的新消息不得被覆盖' } });
    window.__holdSnapshot = false;
    window.__releaseSnapshot();
  });
  await wait(() => document.querySelector('.thread').innerText.includes('快照期间的新消息不得被覆盖'));
  console.log('PASS 重连旧快照不覆盖新消息');

  await evaluate(() => {
    const text = '## 排版与安全检查\n\n**重要提醒**：正文保持常规字重。\n\n[后置引用][ref]\n\n- [x] 完成\n  - 嵌套子项\n\n<script>window.__xss = true</script>\n\n[危险](javascript:alert(1))\n\n![外部图片](https://example.com/test.png)\n\n[ref]: https://example.com/docs\n\n```ts\nconst safe = "已复制";\n```';
    window.__sendEvent('message.part.updated', { part: { id: 'concurrent-text', sessionID: 'ses_a1', messageID: 'concurrent', type: 'text', text } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied = text; } } });
  });
  await wait(() => document.querySelector('.thread').innerText.includes('排版与安全检查'));
  assert.ok(await evaluate(() => !!document.querySelector('.chat-markdown a[href="https://example.com/docs"]')));
  assert.equal(await evaluate(() => !!document.querySelector('.chat-markdown a[href^="javascript:"]') || !!document.querySelector('.chat-markdown img') || !!window.__xss), false);
  await evaluate(() => [...document.querySelectorAll('.chat-md-copy')].at(-1).click());
  await wait(() => !!window.__copied);
  assert.equal(await evaluate(() => window.__copied), 'const safe = "已复制";');
  assert.ok(await evaluate(() => !!document.querySelector('button[aria-label="已复制代码"]')));
  const weights = await evaluate(() => {
    const root = [...document.querySelectorAll('.chat-markdown')].at(-1);
    const style = (selector) => {
      const computed = getComputedStyle(root.querySelector(selector));
      return { weight: Number(computed.fontWeight), color: computed.color };
    };
    return { body: style('li'), strong: style('strong'), heading: style('h2') };
  });
  assert.equal(weights.body.weight, 400);
  assert.equal(weights.strong.weight, 400);
  assert.ok(weights.heading.weight <= 600);
  assert.notEqual(weights.body.color, weights.heading.color);
  console.log('PASS GFM引用/嵌套列表/代码复制与不安全内容过滤', weights);
  await evaluate(() => {
    window.__stableBlock = [...document.querySelectorAll('.chat-markdown')].at(-1).querySelector('.chat-md-block');
    window.__sendEvent('message.part.delta', { sessionID: 'ses_a1', messageID: 'concurrent', partID: 'concurrent-text', field: 'text', delta: '\n\n增量只更新尾部。' });
  });
  await wait(() => document.querySelector('.thread').innerText.includes('增量只更新尾部。'));
  assert.ok(await evaluate(() => window.__stableBlock === [...document.querySelectorAll('.chat-markdown')].at(-1).querySelector('.chat-md-block')));
  console.log('PASS 流式追加不重建已完成的Markdown块');

  await evaluate(() => { window.__holdSnapshot = true; window.__releaseSnapshot = null; window.__bridge('down'); window.__bridge('open'); });
  await wait(() => !!window.__releaseSnapshot);
  await evaluate(() => { window.__oldRelease = window.__releaseSnapshot; window.__holdSnapshot = false; document.querySelectorAll('.sess button.link')[1].click(); });
  await wait(() => document.querySelectorAll('.conversation-turn').length === 0);
  await evaluate(() => document.querySelector('.sess button.link').click());
  await wait(() => document.querySelectorAll('.conversation-turn').length === 250);
  await evaluate(() => {
    window.__sendEvent('message.part.updated', { part: { id: 'concurrent-text', sessionID: 'ses_a1', messageID: 'concurrent', type: 'text', text: '切回来之后的新内容' } });
    window.__oldRelease();
  });
  await wait(() => document.querySelector('.thread').innerText.includes('切回来之后的新内容'));
  assert.equal(await evaluate(() => document.querySelector('.thread').innerText.includes('增量只更新尾部。')), false);
  console.log('PASS 切会话A→B→A后旧请求不能回写');

  for (const width of [880, 1440]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(async () => { const { setThemeMode } = await import('/src/theme.ts'); setThemeMode('dark'); });
    assert.equal(await evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await evaluate(() => document.documentElement.dataset.theme), 'dark');
  }
  await evaluate(async () => { const { setThemeMode } = await import('/src/theme.ts'); setThemeMode('light'); });
  console.log('PASS 深浅主题及880/1440px窗口布局');

  await evaluate(() => {
    window.__sendEvent('message.part.updated', { part: { id: 'concurrent-text', sessionID: 'ses_a1', messageID: 'concurrent', type: 'text', text: '甲' } });
  });
  await wait(() => [...document.querySelectorAll('.chat-markdown')].at(-1)?.innerText === '甲');
  await evaluate(() => {
    window.__fixture = window.__fixture.map((m) => m.info.id === 'concurrent' ? { ...m, parts: m.parts.map((p) => ({ ...p, text: '甲乙' })) } : m);
    window.__holdSnapshot = true;
    window.__releaseSnapshot = null;
    window.__bridge('down'); window.__bridge('open');
  });
  await wait(() => !!window.__releaseSnapshot);
  await evaluate(() => {
    window.__sendEvent('message.part.delta', { sessionID: 'ses_a1', messageID: 'concurrent', partID: 'concurrent-text', field: 'text', delta: '丙' });
    window.__holdSnapshot = false;
    window.__releaseSnapshot();
  });
  await wait(() => [...document.querySelectorAll('.chat-markdown')].at(-1)?.innerText === '甲乙丙');
  console.log('PASS 重连漏字在静稳补拉后恢复，尾部增量不丢');

  await evaluate(() => {
    document.querySelectorAll('.sess button.link')[1].click();
    window.__fixture.push({ info: { id: 'doomed', sessionID: 'ses_a1', role: 'assistant', time: { created: Date.now() } }, parts: [{ id: 'doomed-part', sessionID: 'ses_a1', messageID: 'doomed', type: 'text', text: '不可复活的消息标记' }] });
    window.__holdSnapshot = true;
    window.__releaseSnapshot = null;
  });
  await wait(() => document.querySelectorAll('.conversation-turn').length === 0);
  await evaluate(() => document.querySelector('.sess button.link').click());
  await wait(() => !!window.__releaseSnapshot);
  await evaluate(() => {
    window.__resurrected = false;
    window.__deleteObserver = new MutationObserver(() => {
      if (document.querySelector('.thread').innerText.includes('不可复活的消息标记')) window.__resurrected = true;
    });
    window.__deleteObserver.observe(document.querySelector('.thread'), { subtree: true, childList: true, characterData: true });
    window.__sendEvent('message.removed', { sessionID: 'ses_a1', messageID: 'doomed' });
    window.__holdSnapshot = false;
    window.__releaseSnapshot();
  });
  await wait(() => document.querySelectorAll('.conversation-turn').length === 250);
  assert.equal(await evaluate(() => window.__resurrected || document.querySelector('.thread').innerText.includes('不可复活的消息标记')), false);
  await evaluate(() => window.__deleteObserver.disconnect());
  console.log('PASS 初次回灌期间删除的消息没有被旧快照短暂复活');

  await evaluate(() => document.querySelector('.rail button').click());
  await wait(() => document.querySelector('#m-u-1[data-mounted="true"] .msg.user .text'));
  await evaluate(() => {
    const start = document.querySelector('#m-u-0 .msg.user .text').firstChild;
    const end = document.querySelector('#m-u-1 .msg.user .text').firstChild;
    const range = document.createRange();
    range.setStart(start, 0); range.setEnd(end, end.textContent.length);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    window.__selectedText = selection.toString();
    document.querySelector('.rail button:nth-child(126)').click();
  });
  await wait(() => document.querySelector('#m-u-125[data-mounted="true"] .msg.user'));
  assert.ok(await evaluate(() => window.__selectedText === window.getSelection().toString()));
  await evaluate(() => window.getSelection().removeAllRanges());
  await wait(() => document.querySelector('#m-u-0').dataset.mounted === 'false');
  console.log('PASS 跨轮选区滚出视口仍完整，清除后释放历史DOM');
  await evaluate(() => document.querySelector('.jump-latest').click());
  assert.equal(await evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  await evaluate(() => {
    const text = `## 超长流式正文\n\n${'这是一段需要降级渲染的超长正文。'.repeat(1200)}`;
    window.__emit('session.status', { sessionID: 'ses_a1', status: { type: 'busy' } });
    window.__sendEvent('message.updated', { info: { id: 'heavy', sessionID: 'ses_a1', role: 'assistant', time: { created: Date.now() } } });
    window.__sendEvent('message.part.updated', { part: { id: 'heavy-text', sessionID: 'ses_a1', messageID: 'heavy', type: 'text', text } });
  });
  await wait(() => (document.querySelector('.chat-md-stream')?.textContent.length ?? 0) > 16000);
  await evaluate(() => {
    const text = document.querySelector('.chat-md-stream').textContent;
    window.__sendEvent('message.part.updated', { part: { id: 'heavy-text', sessionID: 'ses_a1', messageID: 'heavy', type: 'text', text, time: { end: Date.now() } } });
    window.__emit('session.status', { sessionID: 'ses_a1', status: { type: 'idle' } });
  });
  await wait(() => !document.querySelector('.chat-md-stream'));
  assert.ok(await evaluate(() => document.querySelector('.thread').innerText.includes('超长流式正文')));
  console.log('PASS 超长流式正文降级为纯文本，完成后恢复 Markdown');

  const shot = await call('Page.captureScreenshot', { format: 'png' });
  const shotPath = join(tmpdir(), 'codearts-conversation-ui.png');
  await writeFile(shotPath, Buffer.from(shot.data, 'base64'));
  console.log('SCREENSHOT', shotPath);
  assert.deepEqual(errors, [], JSON.stringify(errors));
  console.log('PASS 无浏览器控制台错误');
} finally {
  socket?.close();
  chrome.kill();
  await new Promise((resolve) => chrome.exitCode !== null ? resolve() : chrome.once('exit', resolve));
  await rm(profile, { recursive: true, force: true });
}
