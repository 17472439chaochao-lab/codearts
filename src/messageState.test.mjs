import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./messageState.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { applyMessageEvents: apply, reconcileMessages: reconcile, recordSnapshotEvent } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const part = (text = '') => ({ id: 'p1', messageID: 'm1', sessionID: 's1', type: 'text', text });
const msg = (text = '') => ({ info: { id: 'm1', sessionID: 's1', role: 'assistant', time: { created: 1 } }, parts: [part(text)] });
const event = (type, properties) => ({ type, properties: { sessionID: 's1', messageID: 'm1', ...properties } });
const delta = (text) => event('message.part.delta', { partID: 'p1', field: 'text', delta: text });
const full = (text, extra = {}) => event('message.part.updated', { part: { ...part(text), ...extra } });

test('同一批里的增量先于完整正文应用，不重复尾部', () => {
  const result = apply([msg('甲')], [delta('乙'), full('甲乙')]);
  assert.equal(result[0].parts[0].text, '甲乙');
});
test('重复全量事件保持对象引用，正常重复词不能被吞掉', () => {
  const initial = [msg('你好')];
  assert.equal(apply(initial, [full('你好')]), initial);
  assert.equal(apply(initial, [delta('你好')])[0].parts[0].text, '你好你好');
});
test('完成 part 不接受迟到的增量', () => {
  assert.equal(apply([msg()], [full('完成', { time: { end: 10 } }), delta('成')])[0].parts[0].text, '完成');
});
test('早到的增量和 part 在 message.info 之前也不会丢失', () => {
  const result = apply([], [delta('正文'), full(''), event('message.updated', { info: msg().info })]);
  assert.equal(result[0].parts[0].text, '正文');
  assert.equal(result[0].info.time.created, 1);
});
test('批处理保留未变更历史对象并按顺序处理删除', () => {
  const old = { ...msg('历史'), info: { ...msg().info, id: 'history' } };
  const result = apply([old, msg()], [delta('临时'), event('message.part.removed', { partID: 'p1' })]);
  assert.equal(result[0], old);
  assert.deepEqual(result[1].parts, []);
  assert.equal(apply(result, [event('message.removed', {})]).length, 1);
});
test('快照请求期间的正文更新不会被旧快照覆盖', () => {
  const baseline = [msg('甲')];
  const live = apply(baseline, [delta('乙')]);
  assert.equal(reconcile(live, [msg('甲')], baseline)[0].parts[0].text, '甲乙');
});
test('静止时的权威快照能够更正正文并保留相同对象', () => {
  const baseline = [msg('错误')];
  const corrected = reconcile(baseline, [msg('正确')], baseline);
  assert.equal(corrected[0].parts[0].text, '正确');
  assert.equal(reconcile(corrected, [msg('正确')], corrected), corrected);
});
test('快照更新汇总时保留期间追加的新消息', () => {
  const baseline = [msg('正文')];
  const newMsg = { info: { ...msg().info, id: 'm2', role: 'user' }, parts: [] };
  const snapshot = [{ ...baseline[0], info: { ...baseline[0].info, cost: 1 } }];
  const result = reconcile([...baseline, newMsg], snapshot, baseline);
  assert.equal(result[0].info.cost, 1);
  assert.equal(result[1], newMsg);
});
test('请求期间删除的消息和 part 不会被快照复活', () => {
  const baseline = [msg('已删除')];
  assert.deepEqual(reconcile([], baseline, baseline), []);
  const live = apply(baseline, [event('message.part.removed', { partID: 'p1' })]);
  assert.deepEqual(reconcile(live, baseline, baseline)[0].parts, []);
});
test('快照可以移除没有并发变动的旧消息', () => {
  const baseline = [msg('撤销')];
  assert.deepEqual(reconcile(baseline, [], baseline), []);
});
test('同一 message/part ID 的快照只渲染一次', () => {
  const m = msg('唯一');
  m.parts.push(part('唯一'));
  const result = reconcile([msg('唯一')], [m, m], []);
  assert.equal(result.length, 1);
  assert.equal(result[0].parts.length, 1);
});
test('首次回灌期间删除未见过的消息也不会复活', () => {
  const changes = { dirty: false, messages: new Set(), parts: new Set() };
  recordSnapshotEvent(changes, event('message.removed', {}));
  assert.equal(changes.dirty, true);
  assert.deepEqual(reconcile([], [msg('不应复活')], [], changes), []);
});
test('首次回灌期间删除未见过的part也不会复活', () => {
  const changes = { dirty: false, messages: new Set(), parts: new Set() };
  recordSnapshotEvent(changes, event('message.part.removed', { partID: 'p1' }));
  assert.deepEqual(reconcile([], [msg('不应复活')], [], changes)[0].parts, []);
});
test('断线漏字在静稳权威快照后收敛，不按字面去重', () => {
  const baseline = [msg('甲')];
  const changes = { dirty: false, messages: new Set(), parts: new Set() };
  recordSnapshotEvent(changes, delta('丙'));
  const pending = reconcile(apply(baseline, [delta('丙')]), [msg('甲乙')], baseline, changes);
  assert.equal(changes.dirty, true);
  assert.equal(reconcile(pending, [msg('甲乙丙')], pending)[0].parts[0].text, '甲乙丙');
});
test('早到part的占位角色不能覆盖快照里的用户角色', () => {
  const live = apply([], [full('用户输入')]);
  const snapshot = [{ ...msg('用户输入'), info: { ...msg().info, role: 'user' } }];
  assert.equal(reconcile(live, snapshot, [])[0].info.role, 'user');
});
test('增量支持 text 之外的字段', () => {
  const file = { id: 'p1', messageID: 'm1', sessionID: 's1', type: 'file', url: 'https://example.com/a' };
  const result = apply([{ ...msg(), parts: [file] }], [event('message.part.delta', { partID: 'p1', field: 'url', delta: '/b' })]);
  assert.equal(result[0].parts[0].url, 'https://example.com/a/b');
});
test('后续消息信息只带完成时间时保留创建时间', () => {
  const result = apply([msg('正文')], [event('message.updated', { info: { id: 'm1', time: { completed: 10 } } })]);
  assert.equal(result[0].info.time.created, 1);
  assert.equal(result[0].info.time.completed, 10);
});
