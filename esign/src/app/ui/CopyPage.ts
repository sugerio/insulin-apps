import React from 'react';
import { Download } from 'lucide-react';
import { Alert, AlertDescription } from '../components/ui/alert.ts';
import { Button, buttonVariants } from '../components/ui/button.ts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.ts';

const h=React.createElement;

/** The token of a signed-copy link (`/copy#token=<64 hex>`), removed from the address bar once read. */
export function consumeCopyToken(location:{hash:string;pathname:string},history:{replaceState(data:unknown,unused:string,url:string):void}):string{
  const token=new URLSearchParams(location.hash.slice(1)).get('token')??'';
  try{history.replaceState(null,'',location.pathname);}catch{/* best effort */}
  return /^[a-f0-9]{64}$/.test(token)?token:'';
}

/**
 * /copy#token=…: a signer downloads their copy of the signed document from the link in their
 * completion notice. Nothing happens until they press the button, so a mail scanner that opens the
 * link doesn't use it up; the link works once.
 */
export function CopyPage(){
  const [token]=React.useState(()=>typeof window==='undefined'?'':consumeCopyToken(window.location,window.history));
  const [state,setState]=React.useState<'ready'|'busy'|'done'|'unavailable'>(token?'ready':'unavailable');
  const [download,setDownload]=React.useState<{url:string;name:string}|null>(null);
  React.useEffect(()=>()=>{if(download)URL.revokeObjectURL(download.url);},[download]);
  async function open(){
    setState('busy');
    try{
      const response=await fetch('/api/public/copies/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token}),cache:'no-store'});
      if(!response.ok)throw new Error('Unavailable');
      const blob=await response.blob();
      setDownload({url:URL.createObjectURL(blob),name:'signed-document.pdf'});setState('done');
    }catch{setState('unavailable');}
  }
  return h('main',{className:'mx-auto flex min-h-svh w-full max-w-lg items-center px-4 py-12'},
    h(Card,{className:'w-full'},
      h(CardHeader,null,
        h(CardTitle,{className:'text-xl'},h('h1',null,'Your signed document')),
        h(CardDescription,null,'The signed document, followed by its certificate of completion.')),
      h(CardContent,{className:'flex flex-col gap-4'},
        state==='unavailable'?h(Alert,{variant:'destructive'},h(AlertDescription,null,'This link has already been used or has expired. Ask the sender for a copy.')):null,
        state==='ready'||state==='busy'?h(React.Fragment,null,
          h('p',{className:'text-sm text-muted-foreground'},'Download it and keep it for your records. The link works once.'),
          h(Button,{disabled:state==='busy',onClick:()=>void open(),className:'w-full sm:w-auto'},state==='busy'?'Preparing…':'Download my copy')):null,
        state==='done'&&download?h(React.Fragment,null,
          h('p',{role:'status',className:'text-sm'},'Your copy is ready.'),
          h('a',{href:download.url,download:download.name,className:buttonVariants({variant:'outline',className:'w-full sm:w-auto'})},h(Download,{'aria-hidden':true}),'Save the PDF')):null)));
}
