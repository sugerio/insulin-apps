import { defineConfig } from 'vite';
import { resolve } from 'node:path';
// The pages served by the Worker (dist-ui). The test host page that embeds the editor is a test
// fixture (test/fixtures/editor-host.html), built only by test/editor-browser.test.ts.
export default defineConfig({root:'ui',build:{outDir:'../dist-ui',emptyOutDir:true,rollupOptions:{input:{recipient:resolve('ui/index.html'),editor:resolve('ui/editor.html'),demo:resolve('ui/demo.html')}}},server:{host:'127.0.0.1',port:5173,strictPort:true,headers:{'Content-Security-Policy':"frame-ancestors 'self'",'X-Content-Type-Options':'nosniff'}}});
