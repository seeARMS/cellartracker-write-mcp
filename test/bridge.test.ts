import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BrowserBridge} from '../src/bridge.js';
const port=17844,token='a'.repeat(64),base=`http://127.0.0.1:${port}`,headers={Authorization:`Bearer ${token}`};
test('loopback bridge rejects untrusted origins/tokens and completes a single-use job',async t=>{
 const bridge=new BrowserBridge(token,port);await bridge.start();t.after(()=>bridge.close());
 assert.equal((await fetch(base+'/health')).status,401);
 assert.equal((await fetch(base+'/health',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
 const poll=fetch(base+'/poll',{headers});
 // Wait on an observable connection state instead of a fixed startup delay.
 for(let i=0;i<100&&!bridge.connected();i++)await new Promise(r=>setTimeout(r,2));
 const result=bridge.request({kind:'inventory',page:1});
 const job=await (await poll).json();assert.equal(job.request.kind,'inventory');
 const data={id:job.id,response:{status:200,url:'https://www.cellartracker.com/list.asp',text:'example'}};
 assert.equal((await fetch(base+'/result',{method:'POST',headers,body:JSON.stringify(data)})).status,200);
 assert.equal((await result).text,'example');
 assert.equal((await fetch(base+'/result',{method:'POST',headers,body:JSON.stringify(data)})).status,410);
});
