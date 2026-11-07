import React,{useEffect,useRef,useState} from 'react';
const h=React.createElement;
type Recipient={role:string;name:string;email:string};
type Template={id:string;roles:string[];hasPositionedFields:boolean;positionedFieldsSupported?:boolean};
type Props={selection?:{id:string;sequence:number};request:(path:string,init?:RequestInit)=>Promise<Response>;onBegin?:()=>()=>boolean;onCreated:(id:string)=>Promise<void>};

export function TemplateLaunch({request,onBegin,onCreated,selection}:Props){
 const [id,setId]=useState(''),[template,setTemplate]=useState<Template|null>(null),[recipients,setRecipients]=useState<Recipient[]>([]),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const generation=useRef(0),lock=useRef(false),attempt=useRef<{body:string;key:string}|null>(null);
 async function load(selected?:string){if(lock.current)return;const requested=(selected??id).trim(),seq=++generation.current;if(selected!==undefined)setId(selected);setTemplate(null);setRecipients([]);attempt.current=null;setMessage('');if(!/^[a-zA-Z0-9-]{1,64}$/.test(requested)){setMessage('Enter a valid template ID.');return;}setBusy(true);
  try{const data=await (await request(`/templates/${requested}`)).json() as Template;if(seq!==generation.current)return;if(data.id!==requested||!Array.isArray(data.roles)||!data.roles.length||data.roles.length>20||data.roles.some(r=>typeof r!=='string')||typeof data.hasPositionedFields!=='boolean')throw new Error('Invalid template response');setTemplate(data);setRecipients(data.roles.map(role=>({role,name:'',email:''})));if(data.hasPositionedFields&&!data.positionedFieldsSupported)setMessage('Positioned fields in this template are not supported.');}
  catch{if(seq===generation.current)setMessage('Template could not be loaded.');}finally{if(seq===generation.current)setBusy(false);}}
 useEffect(()=>{if(selection)void load(selection.id);},[selection]);
 function change(index:number,key:'name'|'email',value:string){setRecipients(old=>old.map((r,i)=>i===index?{...r,[key]:value}:r));}
 async function start(){if(lock.current||!template||(template.hasPositionedFields&&!template.positionedFieldsSupported))return;
  if(recipients.some(r=>!r.name.trim()||! /^[^@\s]+@(?:example\.com|[a-z0-9.-]+\.test)$/i.test(r.email))){setMessage('Enter a name and a synthetic example.com or .test email for each role.');return;}
  const body=JSON.stringify({templateId:template.id,recipients});if(attempt.current&&attempt.current.body!==body){setMessage('A prior attempt may have created an envelope. Restore the previous details to retry safely.');return;}
  attempt.current??={body,key:crypto.randomUUID()};lock.current=true;setBusy(true);setMessage('');const isCurrent=onBegin?.()??(()=>true);
  try{const result=await (await request('/envelopes',{method:'POST',headers:{'content-type':'application/json','idempotency-key':attempt.current.key},body})).json() as {id:string};if(!result.id)throw new Error('Invalid envelope');if(!isCurrent()){console.warn(`Superseded local envelope: ${result.id}`);setMessage('A newer operation is selected; the created envelope was retained for investigation.');return;}setMessage(`Envelope ${result.id} created. Preparing…`);await onCreated(result.id);setMessage(`Envelope ${result.id} created.`);}
  catch{setMessage('Request failed or result is unknown. Retry with the same details; do not start another request until checked.');}
  finally{lock.current=false;setBusy(false);}}
 return h('section',{'aria-label':'Start from template'},h('h2',null,'Start signing from a template'),h('p',null,'Local synthetic test only. Roles are used in the order shown.'),
  h('label',null,'Template ID ',h('input',{'aria-label':'Template ID',value:id,disabled:busy,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>{generation.current++;setId(e.target.value);setTemplate(null);setRecipients([]);setMessage('');attempt.current=null;}})),h('button',{type:'button',disabled:busy,onClick:()=>void load()},'Load template'),
  template&&h(React.Fragment,null,...recipients.map((recipient,i)=>h('fieldset',{key:i},h('legend',null,`${i+1}. ${recipient.role}`),h('label',null,'Name ',h('input',{'aria-label':`${recipient.role} name`,value:recipient.name,disabled:busy,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>change(i,'name',e.target.value)})),h('label',null,'Test email ',h('input',{'aria-label':`${recipient.role} email`,value:recipient.email,disabled:busy,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>change(i,'email',e.target.value)})))),h('button',{type:'button',disabled:busy||(template.hasPositionedFields&&!template.positionedFieldsSupported),onClick:start},'Start signing from template')),
  h('p',{role:'status'},message));
}
