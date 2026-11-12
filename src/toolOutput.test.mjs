import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./toolOutput.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { readableToolOutput } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('普通工具输出保持原样', () => {
  assert.equal(readableToolOutput('构建通过\n共 3 个文件'), '构建通过\n共 3 个文件');
});

test('剥离内核给模型看的 path/type/content 包装', () => {
  const output = '<path>/tmp/demo.ts</path>\n<type>file</type>\n<content>\nconst a = 1;\n  const b = 2;\n</content>';
  assert.equal(readableToolOutput(output), 'const a = 1;\n  const b = 2;');
});

test('只有 path 包装时也能取出正文', () => {
  assert.equal(readableToolOutput('<path>/tmp/a.txt</path>\n<content>正文</content>'), '正文');
});

test('正文自身包含标签但整体不是包装时不误伤', () => {
  const output = '示例：\n<content>保留</content>\n结束';
  assert.equal(readableToolOutput(output), output);
});

test('只有包装字段但没有 content 时保持原样', () => {
  const output = '<path>/tmp/a.txt</path>\n<type>file</type>';
  assert.equal(readableToolOutput(output), output);
});