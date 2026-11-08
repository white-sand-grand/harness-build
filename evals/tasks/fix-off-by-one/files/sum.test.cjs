const {test}=require('node:test');const assert=require('node:assert/strict');const {sum}=require('./sum.cjs');
test('empty',()=>assert.equal(sum([]),0));test('single',()=>assert.equal(sum([7]),7));test('several',()=>assert.equal(sum([1,2,3]),6));test('negative',()=>assert.equal(sum([-2,4,-1]),1));
