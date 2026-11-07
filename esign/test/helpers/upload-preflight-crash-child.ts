import {runUploadPreflight} from '../../scripts/upload-completion-state.ts';
await runUploadPreflight(process.argv[2],async()=>{
 process.stdout.write('preflight-entered\n');
 setInterval(()=>{},1000);await new Promise(()=>{});
 return 'UNSIGNED';
});
