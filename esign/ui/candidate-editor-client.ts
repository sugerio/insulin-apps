export function consumeCandidateEditorFragment(location:{hash:string;pathname:string;search:string},history:{replaceState:(data:unknown,unused:string,url:string)=>void}):{pageId:string;code:string} {
 const fragment=location.hash.slice(1);
 history.replaceState(null,'',location.pathname+location.search);
 const params=new URLSearchParams(fragment),pageId=params.get('pageId'),code=params.get('code');
 if([...params.keys()].length!==2||!pageId||!code||!/^[a-f0-9]{64}$/.test(pageId)||!/^[a-f0-9]{64}$/.test(code))throw new Error('Invalid editor link');
 return {pageId,code};
}
export function candidateEditorGateway(value:string):string {
 const url=new URL(value);
 if(url.protocol!=='https:'||url.origin!==value)throw new Error('Invalid editor gateway');
 return value;
}
