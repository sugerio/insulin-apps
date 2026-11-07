import {once} from 'node:events';
const {startLocalHost}=await import('../../scripts/local-host.ts');
const server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{port:0});await once(server,'listening');
process.stdout.write(`PORT ${(server.address() as import('node:net').AddressInfo).port}\n`);
process.on('SIGTERM',()=>server.close(()=>setTimeout(()=>process.exit(0),300)));
