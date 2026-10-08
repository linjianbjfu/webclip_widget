import {describe,it,expect} from 'vitest';
import {DOM_LIMITS,parseDomSnapshot,serializeDomSnapshot,validateDomSnapshot,type DomNode} from './dom-snapshot.ts';

export const emptyDom: DomNode = [1,0,'html',[],[[1,0,'head',[],[]],[1,0,'body',[],[]]]];

describe('DOM snapshot validation',()=>{
  it('pairs exact UTF-8 source bytes with a bounded versioned tree',async()=>{
    const json=await serializeDomSnapshot('<html>中文</html>',emptyDom);
    expect((await validateDomSnapshot('<html>中文</html>',json)).root).toEqual(emptyDom);
    await expect(validateDomSnapshot('<html>different</html>',json)).rejects.toThrow('does not match');
    const header=JSON.parse(json);
    for(const changed of [{...header,version:2},{...header,sourceSha256:'wrong'},{...header,root:[3,'text']},{...header,root:[1,0,'body',[],[]]}])expect(()=>parseDomSnapshot(JSON.stringify(changed))).toThrow();
  });
  it('rejects malformed types, attributes, namespace codes and template content',async()=>{
    const header=JSON.parse(await serializeDomSnapshot('',emptyDom));
    for(const child of [[7,'code'],{},[3,null],[1,9,'div',[],[]],[1,0,'bad name',[],[]],
      [1,0,'div',[[null,'id','a'],[null,'id','b']],[]],[1,0,'div',[[null,'id',2]],[]],
      [1,0,'div',[],[],[]],[1,0,'template',[],[],{}]]){
      expect(()=>parseDomSnapshot(JSON.stringify({...header,root:[1,0,'html',[],[child]]}))).toThrow();
    }
    expect(()=>parseDomSnapshot('{broken')).toThrow();
  });
  it('rejects oversized bodies, excessive depth and node counts',async()=>{
    const header=JSON.parse(await serializeDomSnapshot('',emptyDom));
    await expect(validateDomSnapshot('x'.repeat(DOM_LIMITS.bytes+1),JSON.stringify(header))).rejects.toThrow('16 MiB');
    const wrap=(root:unknown)=>JSON.stringify({...header,root});
    expect(()=>parseDomSnapshot(wrap([1,0,'html',[],[[3,'x'.repeat(DOM_LIMITS.bytes)]]]))).toThrow('16 MiB');
    let nested:unknown=[3,'leaf'];for(let i=0;i<=DOM_LIMITS.depth;i++)nested=[1,0,'div',[],[nested]];
    expect(()=>parseDomSnapshot(wrap([1,0,'html',[],[nested]]))).toThrow('depth');
    expect(()=>parseDomSnapshot(wrap([1,0,'html',[],Array.from({length:DOM_LIMITS.nodes},()=>[3,''])]))).toThrow('node/depth');
  });
});
