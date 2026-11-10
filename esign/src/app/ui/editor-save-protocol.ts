type Message = {origin:string;source:unknown;data:unknown};
const requestIdValid=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function readSaveRequest(event:Message,origin:string,parent:unknown):string|null {
 if(!parent||event.source!==parent||event.origin!==origin||!record(event.data)||event.data.type!=='esign.editor.save'||!requestIdValid(event.data.requestId)||Object.keys(event.data).length!==2)return null;
 return event.data.requestId;
}
export function readSaveResult(event:Message,origin:string,source:unknown,requestId:string):{type:'esign.editor.saved';templateId:string}|{type:'esign.editor.save-error';message:string}|null {
 if(!source||!requestIdValid(requestId)||event.source!==source||event.origin!==origin||!record(event.data)||event.data.requestId!==requestId)return null;
 if(event.data.type==='esign.editor.saved'&&typeof event.data.templateId==='string'&&/^[a-f0-9-]{36}$/.test(event.data.templateId)&&Object.keys(event.data).length===3)return {type:'esign.editor.saved',templateId:event.data.templateId};
 if(event.data.type==='esign.editor.save-error'&&typeof event.data.message==='string'&&event.data.message.length<=300&&Object.keys(event.data).length===3)return {type:'esign.editor.save-error',message:event.data.message};
 return null;
}
