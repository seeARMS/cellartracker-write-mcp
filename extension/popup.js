const status=document.getElementById('status');
async function refresh(){
 const {pairing,enabled}=await chrome.storage.local.get(['pairing','enabled']);
 if(!pairing){status.textContent='Import a pairing file to begin.';return;}
 if(!enabled){status.textContent='Disconnected.';return;}
 try{const r=await fetch('http://127.0.0.1:17843/health',{headers:{Authorization:'Bearer '+pairing.token},signal:AbortSignal.timeout(2000)});const result=await r.json();status.textContent=result.connected?'Connected.':'Waiting for connection…';}catch{status.textContent='Start the local MCP server to connect.';}
}
document.getElementById('pairing').addEventListener('change',async e=>{
 try{const data=JSON.parse(await e.target.files[0].text());if(data.port!==17843||typeof data.token!=='string'||!/^[0-9a-f]{64}$/.test(data.token))throw Error();await chrome.storage.local.set({pairing:{port:17843,token:data.token},enabled:true});await chrome.runtime.sendMessage({type:'connect'});await refresh();}catch{status.textContent='Invalid pairing file.';}
});
document.getElementById('connect').addEventListener('click',async()=>{await chrome.storage.local.set({enabled:true});await chrome.runtime.sendMessage({type:'connect'});await refresh();});
document.getElementById('disconnect').addEventListener('click',async()=>{await chrome.storage.local.set({enabled:false});await refresh();});
void refresh();
