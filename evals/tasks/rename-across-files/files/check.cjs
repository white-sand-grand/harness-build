const fs=require('node:fs');const {spawnSync}=require('node:child_process');const assert=require('node:assert/strict');
const r=spawnSync(process.execPath,['--test'],{stdio:'inherit'});assert.equal(r.status,0);for(const f of fs.readdirSync('src'))assert.ok(!fs.readFileSync('src/'+f,'utf8').includes('getUsr'),f+' still has old identifier');
