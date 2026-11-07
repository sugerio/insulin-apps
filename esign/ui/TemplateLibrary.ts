import React,{useEffect,useRef,useState} from 'react';
const h=React.createElement;
type Page={templates:{id:string;createdAt:number}[];nextCursor:string|null};
export function TemplateLibrary({request,onSelect}:{request:(path:string)=>Promise<Response>;onSelect:(id:string)=>void}){
 const [page,setPage]=useState<Page|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[history,setHistory]=useState<string[]>(['']);
 const generation=useRef(0);
 async function load(cursor:string,nextHistory:string[]){const seq=++generation.current;setLoading(true);setError('');
  try{const result=await (await request(`/templates?cursor=${encodeURIComponent(cursor)}`)).json() as Page;if(!Array.isArray(result.templates)||result.templates.length>20||result.templates.some(t=>!t||typeof t.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(t.id)||!Number.isSafeInteger(t.createdAt))||(result.nextCursor!==null&&(typeof result.nextCursor!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(result.nextCursor))))throw new Error('Invalid template list');if(generation.current!==seq)return;setPage(result);setHistory(nextHistory);}
  catch{if(generation.current===seq){setPage(null);setError('Could not load templates. Retry.');}}finally{if(generation.current===seq)setLoading(false);}}
 useEffect(()=>{void load('', ['']);return ()=>{generation.current++;};},[]);
 return h('section',{'aria-label':'Template library'},h('h2',null,'Templates'),h('a',{href:'/editor-host.html'},'Create new template'),h('button',{type:'button',disabled:loading,onClick:()=>void load('', [''])},'Refresh templates'),
  loading&&h('p',null,'Loading templates…'),error&&h('p',{role:'alert'},error),!loading&&page?.templates.length===0&&h('p',null,'No templates yet.'),
  page&&h('ul',null,...page.templates.map(template=>h('li',{key:template.id},h('button',{type:'button','aria-label':`Select template ${template.id}`,onClick:()=>onSelect(template.id)},template.id)))),
  page&&h('div',null,h('button',{type:'button',disabled:loading||history.length<=1,onClick:()=>{const previous=history.slice(0,-1);void load(previous[previous.length-1],previous);}},'Previous templates'),h('button',{type:'button',disabled:loading||!page.nextCursor,onClick:()=>{if(page.nextCursor)void load(page.nextCursor,[...history,page.nextCursor]);}},'Next templates')));
}
