const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const vm=require('node:vm');
function api(){const box={module:{exports:{}}};vm.runInNewContext(readFileSync(`${__dirname}/c-highlight.js`,'utf8'),box);return box.module.exports;}
test('C 词法分类区分控制、类型、调用、宏、常量和字段',()=>{
 const {highlightC}=api();const tokens=highlightC('#define LIMIT 0x20U\nstatic unsigned send(struct Route *r) { if (r->len > LIMIT) return write_reg(1); }').flat();
 const kind=text=>tokens.find(t=>t.text===text)?.kind;
 assert.equal(kind('#define'),'preprocessor');assert.equal(kind('LIMIT'),'constant');assert.equal(kind('0x20U'),'number');
 assert.equal(kind('unsigned'),'type');assert.equal(kind('Route'),'type');assert.equal(kind('send'),'function');assert.equal(kind('write_reg'),'function');assert.equal(kind('return'),'control');assert.equal(kind('len'),'identifier');
});
test('跨行注释和转义字符串不误着色，保留每个字符及空行',()=>{
 const {highlightC}=api();const source='/* if (fake())\nreturn 1; */\n\nconst char *s = "<script>\\\" // if"; // return\n';
 const lines=highlightC(source);assert.equal(lines.map(l=>l.map(t=>t.text).join('')).join('\n'),source);
 assert.ok(lines[1].every(t=>t.kind==='comment'));assert.ok(lines[3].some(t=>t.kind==='string'&&t.text.includes('<script>')));
 assert.ok(lines[3].some(t=>t.kind==='comment'&&t.text==='// return'));
});
test('头文件、字符字面量、续行字符串和数字不会破坏行号',()=>{
 const {highlightC}=api();const source='#include <stdint.h>\nchar c = \'\\n\'; double n = .5e-2 + 0x1.fp3;\n"a\\\nb"\n';
 const lines=highlightC(source);assert.equal(lines.length,source.split('\n').length);
 assert.equal(lines.map(l=>l.map(t=>t.text).join('')).join('\n'),source);
 assert.ok(lines[0].some(t=>t.kind==='string'&&t.text==='<stdint.h>'));
 for(const num of ['.5e-2','0x1.fp3'])assert.ok(lines.flat().some(t=>t.text===num&&t.kind==='number'));
 assert.ok(lines[3].some(t=>t.kind==='string'&&t.text==='b"'));
});
