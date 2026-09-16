chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if(sender.id!==chrome.runtime.id || message?.type!=='cellartracker-request')return;
  (async()=>{
    if(!(await chrome.storage.local.get('enabled')).enabled)throw new Error('Disconnected');
    if(location.origin!=='https://www.cellartracker.com')throw new Error('Wrong origin');
    if(!Number.isFinite(message.expiresAt)||message.expiresAt<Date.now()+2000)throw new Error('Expired job');
    const request=CellarTrackerProtocol.build(message.request);
    const response=await fetch(request.path,{method:request.method,body:request.body,credentials:'same-origin',cache:'no-store',redirect:'error',headers:request.method==='POST'?{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest'}:{},signal:AbortSignal.timeout(25000)});
    const bytes=await response.arrayBuffer();
    if(bytes.byteLength>12_000_000)throw new Error('Response too large');
    const charset=response.headers.get('content-type')?.match(/charset=([^;\s]+)/i)?.[1]??'windows-1252';
    return {response:{status:response.status,url:response.url,text:new TextDecoder(charset).decode(bytes)}};
  })().then(sendResponse,()=>sendResponse({error:'Request failed. Check the signed-in CellarTracker tab.'}));
  return true;
});
