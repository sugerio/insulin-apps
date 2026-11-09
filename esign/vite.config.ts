import { defineConfig } from 'vite';
import { resolve } from 'node:path';
const alternatePorts=process.env.ESIGN_SYNTHETIC_ALTERNATE_PORTS==='YES';
const v3Demo=process.env.ESIGN_EDITOR_V3_DEMO==='YES';
export default defineConfig({root:'ui',build:{outDir:'../dist-ui',emptyOutDir:true,rollupOptions:{input:{recipient:resolve('ui/index.html'),editor:resolve('ui/editor.html'),demo:resolve('ui/demo.html')}}},server:{host:'127.0.0.1',port:v3Demo?5197:alternatePorts?5174:5173,strictPort:true,headers:{'Content-Security-Policy':"frame-ancestors 'self'",'X-Content-Type-Options':'nosniff'},proxy:{'/host/':{target:v3Demo?'http://127.0.0.1:8798':alternatePorts?'http://127.0.0.1:8789':'http://127.0.0.1:8788',changeOrigin:true}}}});
