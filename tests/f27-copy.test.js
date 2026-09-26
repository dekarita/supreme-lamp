const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ui=fs.readFileSync('payloads/ui.html','utf8');
test('F27 masked KEYS copy uses full JS state, never masked or stale DOM',()=>{
 const src=ui.slice(ui.indexOf('var keySecrets='),ui.indexOf('function copyLog'));
 const copied=[];
 const ctx={copyText:v=>copied.push(v),$:()=>{throw Error('secret handler read DOM');}};
 vm.createContext(ctx);vm.runInContext(src,ctx);
 for(const id of ['credWinPass','credVncPass']){
  const real='synthetic-fixture-12345!';
  ctx.keySecrets[id]=real;ctx.copyById(id);
  assert.equal(copied.at(-1),real);
  assert.equal(copied.at(-1).length,real.length);
  assert.ok(!copied.at(-1).includes('*'));
  ctx.keySecrets[id]='';ctx.copyById(id);assert.equal(copied.at(-1),'');
 }
 assert.match(ui,/keySecrets\[id\]=val\?String\(val\):''/);
 assert.doesNotMatch(ui,/setAttribute\('data-full',val\)/);
});
