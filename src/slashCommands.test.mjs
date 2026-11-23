import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./slashCommands.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { slashToken, slashMatches, expandSlash } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('slashToken 正确解析前缀', () => {
  assert.equal(slashToken(''), null);
  assert.equal(slashToken('hello'), null);
  assert.equal(slashToken('/'), '');
  assert.equal(slashToken('/commit'), 'commit');
  assert.equal(slashToken('/commit something'), null);
});

test('slashMatches 过滤候选', () => {
  const cmds = [{ name: 'commit' }, { name: 'compact' }, { name: 'help' }];
  assert.deepEqual(slashMatches('/c', cmds), [{ name: 'commit' }, { name: 'compact' }]);
  assert.deepEqual(slashMatches('/com', cmds), [{ name: 'commit' }, { name: 'compact' }]);
  assert.deepEqual(slashMatches('/h', cmds), [{ name: 'help' }]);
  assert.deepEqual(slashMatches('no slash', cmds), []);
});

test('expandSlash 展开参数和模板', () => {
  const cmds = [
    { name: 'review', template: '请代码审查：$ARGUMENTS' },
    { name: 'test', template: '运行单元测试' },
  ];
  assert.equal(expandSlash('/review src/App.tsx', cmds), '请代码审查：src/App.tsx');
  assert.equal(expandSlash('/test', cmds), '运行单元测试');
  assert.equal(expandSlash('/test extra', cmds), '运行单元测试\n\nextra');
  assert.equal(expandSlash('普通问题', cmds), '普通问题');
});
