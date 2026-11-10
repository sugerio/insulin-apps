import {PDFDocument,PDFName} from 'pdf-lib';

export async function syntheticInlineImagePdf(broken:boolean) {
  const pdf=await PDFDocument.create(),page=pdf.addPage([100,100]);
  const content=`q 20 0 0 20 5 5 cm BI /W 1 /H 1 ${broken?'':'/BPC 8 '}/CS /RGB ID abc EI Q`;
  page.node.set(PDFName.of('Contents'),pdf.context.register(pdf.context.flateStream(content)));
  return new Blob([new Uint8Array(await pdf.save())],{type:'application/pdf'});
}

export function fakePreviewNode() {
  const makeNode=()=>({children:[] as any[],appendChild(node:any){this.children.push(node);},replaceChildren(...nodes:any[]){this.children=nodes;}});
  const doc:any={createElement(tag:string){
    if(tag!=='canvas') {const element:any=makeNode();element.ownerDocument=doc;return element;}
    const noop=()=>{};const canvas:any={width:0,height:0,style:{},dataset:{}};
    const context=new Proxy({canvas,getTransform:()=>({a:1,b:0,c:0,d:1,e:0,f:0,invertSelf(){return this;}}),measureText:()=>({width:1}),createImageData:(w:number,h:number)=>({data:new Uint8ClampedArray(w*h*4),width:w,height:h})} as any,{get:(obj,key)=>key in obj?obj[key]:noop,set:(obj,key,value)=>{obj[key]=value;return true;}});
    canvas.getContext=()=>context;return canvas;
  }};
  const node:any=makeNode();node.ownerDocument=doc;return node;
}
