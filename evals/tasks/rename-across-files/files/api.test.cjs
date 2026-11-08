const {test}=require('node:test');const assert=require('node:assert/strict');const api=require('./src/index.cjs');
test('new name',()=>assert.deepEqual(api.getUser(7),{id:7,name:'Ada'}));test('lookup',()=>assert.deepEqual(api.lookup(9),{id:9,name:'Ada'}));
