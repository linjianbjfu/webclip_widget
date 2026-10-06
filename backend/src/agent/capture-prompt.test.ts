import { it, expect } from 'vitest';
import { capturePrompt, ensureCaptureBudget } from './capture-prompt.ts';

it('passes captured and live XPath together in model context',()=>{
 const region={id:'r1',xpath:'/html/body/div/a',sourceXPath:'/html/body/a/div/a',rect:{x:0,y:0,width:100,height:20},text:'作者'};
 const prompt=capturePrompt('新闻 widget',{version:1,mode:'regions',source:'source.html',viewport:{width:1280,height:900},regions:[region],images:[]});
 expect(prompt).toContain(JSON.stringify(region));
});

it('capture budget includes this turn and compacts once before rejecting oversized history',async()=>{
 let compacted=0,tokens=95000;
 const session={model:{contextWindow:200000,maxTokens:50000},messages:[{}],getContextUsage:()=>({tokens}),compact:async()=>{compacted++;tokens=1000;}};
 await ensureCaptureBudget(session,'request',1);expect(compacted).toBe(0);
 tokens=150000;await ensureCaptureBudget(session,'request',1);expect(compacted).toBe(1);
 session.compact=async()=>{compacted++;};tokens=199000;
 await expect(ensureCaptureBudget(session,'request',1)).rejects.toThrow('context_budget_exceeded');
 await expect(ensureCaptureBudget(session,'a'.repeat(500000),1)).rejects.toThrow('context_budget_exceeded');
 expect(capturePrompt('original')).toBe('original');
});
