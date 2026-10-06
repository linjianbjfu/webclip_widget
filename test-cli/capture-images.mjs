/** Compose captured pixels without changing the source page's layout or viewport. */
export async function composeCaptureImage(page, tiles, mode, originalSize) {
  return page.evaluate(async ({tiles,mode,originalSize}) => {
    const bitmaps=await Promise.all(tiles.map(tile=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(Error('Cannot decode screenshot'));img.src='data:image/png;base64,'+tile.data;})));
    const max=mode==='page'?768:1200, gap=8, label=24;
    if(!tiles.length)return null;
    const sizes=bitmaps.map(img=>{const scale=Math.min(1,768/img.width,768/img.height);return {width:Math.max(1,Math.floor(img.width*scale)),height:Math.max(1,Math.floor(img.height*scale))};});
    let layout;
    if(mode==='page')layout={width:sizes[0].width,height:sizes[0].height,scale:1,boxes:[{x:0,y:0,...sizes[0]}]};
    else {
      for(let columns=1;columns<=tiles.length;columns++) {
        const rows=Math.ceil(tiles.length/columns), cw=Array(columns).fill(0),rh=Array(rows).fill(0);
        sizes.forEach((s,i)=>{cw[i%columns]=Math.max(cw[i%columns],s.width);rh[Math.floor(i/columns)]=Math.max(rh[Math.floor(i/columns)],s.height);});
        const availableW=max-gap*(columns+1),availableH=max-gap*(rows+1)-label*rows;
        const scale=Math.min(1,availableW/cw.reduce((a,b)=>a+b,0),availableH/rh.reduce((a,b)=>a+b,0));
        const boxes=sizes.map((s,i)=>({x:gap+cw.slice(0,i%columns).reduce((a,b)=>a+Math.floor(b*scale)+gap,0),y:gap+label+rh.slice(0,Math.floor(i/columns)).reduce((a,b)=>a+Math.floor(b*scale)+gap+label,0),width:Math.max(1,Math.floor(s.width*scale)),height:Math.max(1,Math.floor(s.height*scale))}));
        const width=Math.max(...boxes.map(b=>b.x+b.width))+gap,height=Math.max(...boxes.map(b=>b.y+b.height))+gap;
        if(!layout||scale>layout.scale||scale===layout.scale&&width*height<layout.width*layout.height)layout={width,height,scale,boxes};
      }
    }
    const canvas=document.createElement('canvas');canvas.width=layout.width;canvas.height=layout.height;
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
    layout.boxes.forEach((box,i)=>{
      if(mode!=='page'){ctx.fillStyle='#17202a';ctx.font='bold 16px sans-serif';ctx.fillText(tiles[i].id,box.x,box.y-6);}
      ctx.drawImage(bitmaps[i],box.x,box.y,box.width,box.height);
    });
    let url=canvas.toDataURL('image/png');
    const bytes=url=>Math.floor(url.split(',')[1].length*3/4)-(url.endsWith('==')?2:url.endsWith('=')?1:0);
    if(bytes(url)>2*1024*1024)url=canvas.toDataURL('image/jpeg',.9);
    if(bytes(url)>2*1024*1024)throw Error('截图超过 2 MiB，请减少区域');
    const mimeType=url.startsWith('data:image/png')?'image/png':'image/jpeg';
    return {data:url.split(',')[1],url,mimeType,bytes:bytes(url),width:canvas.width,height:canvas.height,originalWidth:originalSize.width,originalHeight:originalSize.height,boxes:layout.boxes};
  }, {tiles,mode,originalSize});
}
