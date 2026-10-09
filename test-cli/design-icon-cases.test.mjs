import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertIconDisplay,assertSeparateScores,assertReadableIdentities,assertImageEmphasis} from './design-icon-cases.mjs';
test('identity check rejects missing, shrunk and clipped names',()=>{
 const row={title:'云端协作笔记本',font:15,clipped:false};
 assertReadableIdentities({records:[row]},[row.title]);
 assertReadableIdentities({records:[{...row,font:12}]},[row.title],12);
 assert.throws(()=>assertReadableIdentities({records:[{...row,font:11}]},[row.title],12),/font shrank/);
 for(const records of [[],[{...row,font:12}],[{...row,clipped:true}]])assert.throws(()=>assertReadableIdentities({records},[row.title]));
});
test('score gate rejects concatenated or frozen nested values within the named record',()=>{
 const data={teams:[{name:'TOR',score:'3',shootout:'1'},{name:'VGK',score:4,shootout:2}]};
 assertSeparateScores(data);
 assert.throws(()=>assertSeparateScores({teams:[{name:'TOR',score:'31'},{name:'VGK',score:'42'}]}),/remain separate/);
 assert.throws(()=>assertSeparateScores(data,[['TOR','5','2'],['VGK','6','3']]),/remain separate/);
});
test('explicit all-icon scenario rejects omitted imagery, wrong images and missing requested backgrounds',()=>{
 const expected=Array.from({length:14},(_,i)=>'image-'+i),display={images:expected,decoration:true};
 assertIconDisplay(display,{expectedIcons:14,expected,background:true});
 assert.throws(()=>assertIconDisplay({...display,images:expected.slice(0,2)},{expectedIcons:14}),/visible record icons/);
 assert.throws(()=>assertIconDisplay(display,{expectedIcons:14,expected:['wrong-image']}),/not displayed/);
 assert.throws(()=>assertIconDisplay({...display,decoration:false},{expectedIcons:14,background:true}),/theme layer/);
 assert.throws(()=>assertIconDisplay(display,{noImage:true}),/no-image/);
 assert.throws(()=>assertIconDisplay({images:[],decoration:true},{noImage:true}),/no-theme/);
 assertIconDisplay({images:[],decoration:false},{noImage:true});
 assert.throws(()=>assertIconDisplay({images:['a','b'],pairs:[{uri:'a',label:'B'},{uri:'b',label:'A'}]},{expectedIcons:2,pairs:[{uri:'a',label:'A'}]}),/wrong record/);
});

test('image emphasis rejects token-size artwork despite a large outer image box',()=>{
 assertImageEmphasis({artwork:[{width:28,height:28}]},1);
 assert.throws(()=>assertImageEmphasis({artwork:[{width:18,height:18,box:40}]},1),/too small/);
 assert.throws(()=>assertImageEmphasis({artwork:[]},1),/missing/);
});
