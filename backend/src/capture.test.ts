import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { encode } from 'fast-png';
import jpeg from 'jpeg-js';
import { parseCapture, type Capture } from './capture.ts';
import { validateCaptureImage } from './do/capture-image.ts';
import { parseMultipartPrompt } from './do/upload.ts';

export function fixtureCapture(): {capture: Capture; png: Buffer} {
  const png=Buffer.from(encode({width:20,height:20,data:new Uint8Array(20*20*4).fill(255),channels:4}));
  return {png,capture:{version:1,mode:'regions',source:'source.html',viewport:{width:1280,height:900},regions:[{id:'r1',xpath:"//*[@id='quote']",rect:{x:0,y:0,width:20,height:20},text:'quote',imageId:'image',imageRect:{x:0,y:0,width:20,height:20}}],images:[{id:'image',file:'regions.png',width:20,height:20,originalWidth:20,originalHeight:20,bytes:png.length,mimeType:'image/png',role:'montage'}]}};
}
describe('capture contract',()=>{
  it('preserves optional live sourceXPath and rejects invalid values',()=>{
    const {capture}=fixtureCapture();
    const withPath={...capture,regions:capture.regions.map(r=>({...r,sourceXPath:'/html[1]/body[1]/a[1]'}))};
    expect(parseCapture(withPath)).toEqual(withPath);
    for(const sourceXPath of ['',null,42,'a'.repeat(4097)])expect(()=>parseCapture({...capture,regions:capture.regions.map(r=>({...r,sourceXPath}))})).toThrow();
  });
  it('accepts ordered region montage, text-only capture and full-page image',()=>{
    const {capture,png}=fixtureCapture();expect(parseCapture(capture)).toEqual(capture);validateCaptureImage(png,capture.images[0]!);
    expect(parseCapture({...capture,images:[],regions:[{id:'r3',xpath:'/html/body/p',rect:{x:0,y:0,width:100,height:20},text:'Only text'}]}).images).toEqual([]);
    const page={...capture,mode:'page',regions:[],images:capture.images.map(i=>({...i,role:'full-page'}))};expect(parseCapture(page).mode).toBe('page');
    const jpg=jpeg.encode({width:20,height:20,data:Buffer.alloc(1600,255)},90).data;
    validateCaptureImage(jpg,{...capture.images[0]!,mimeType:'image/jpeg',bytes:jpg.length});
  });
  it('rejects malformed references, dimensions, modes and metadata',()=>{
    const {capture}=fixtureCapture();
    for(const value of [null,{}, {...capture,version:2},{...capture,source:'../source.html'}, {...capture,regions:[]}, {...capture,images:[]}, {...capture,regions:[...capture.regions,...capture.regions]}, {...capture,regions:Array(9).fill(capture.regions[0])}, {...capture,images:[...capture.images,...capture.images]}, {...capture,pageUrl:'file:///secret'}, {...capture,images:capture.images.map(i=>({...i,width:1201}))}, {...capture,regions:capture.regions.map(r=>({...r,imageRect:{x:19,y:0,width:20,height:20}}))}, {...capture,regions:capture.regions.map(r=>({...r,xpath:''}))}]) expect(()=>parseCapture(value)).toThrow();
  });
  it('decodes bytes rather than trusting extension or claimed dimensions',()=>{
    const {capture,png}=fixtureCapture(),image=capture.images[0]!;
    expect(()=>validateCaptureImage(png,{...image,width:19})).toThrow(/mismatch/);
    expect(()=>validateCaptureImage(png,{...image,mimeType:'image/jpeg'})).toThrow(/mismatch/);
    expect(()=>validateCaptureImage(Buffer.from('not an image'),{...image,bytes:12})).toThrow();
    const corrupt=Buffer.from(png);corrupt[45]=corrupt[45]!^255;
    expect(()=>validateCaptureImage(corrupt,image)).toThrow(/decoded/);
    const enormous=Buffer.from(png);enormous.writeUInt32BE(90000,16);
    expect(()=>validateCaptureImage(enormous,image)).toThrow(/dimensions/);
    expect(()=>validateCaptureImage(Buffer.alloc(2*1024*1024+1),image)).toThrow(/byte/);
  });
  it('multipart validates complete capture before returning any accepted files',async()=>{
    const {capture,png}=fixtureCapture(),form=new FormData();form.set('capture',JSON.stringify(capture));form.append('file',new File(['<p id="quote">quote</p>'],'source.html'));
    await expect(parseMultipartPrompt(form)).rejects.toThrow(/missing/);
    form.append('file',new File([png],'regions.png'));
    expect((await parseMultipartPrompt(form)).capture).toEqual(capture);
    form.append('file',new File(['duplicate'],'source.html'));
    await expect(parseMultipartPrompt(form)).rejects.toThrow(/Duplicate/);
  });
});
