const {test}=require('node:test');const assert=require('node:assert/strict');const {spawnSync}=require('node:child_process');
const run=(args)=>{const r=spawnSync(process.execPath,['cli.cjs',...args],{encoding:'utf8'});assert.equal(r.status,0);return r.stdout.trimEnd();};
test('plain',()=>assert.equal(run(['hello','world']),'hello world'));test('upper',()=>assert.equal(run(['--upper','hello','world']),'HELLO WORLD'));test('flag at end',()=>assert.equal(run(['hello','--upper']),'HELLO'));test('empty',()=>assert.equal(run(['--upper']),''));
