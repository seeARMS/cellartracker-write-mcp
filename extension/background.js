let running=false;
async function connect(){
  if(running)return;running=true;
  try{
    while(true){
      const {pairing,enabled}=await chrome.storage.local.get(['pairing','enabled']);
      if(!enabled||!pairing)break;
      const headers={Authorization:'Bearer '+pairing.token};
      const base='http://127.0.0.1:17843';
      const response=await fetch(base+'/poll',{headers,signal:AbortSignal.timeout(25000)});
      if(response.status===204)continue;
      if(!response.ok)throw new Error('Bridge unavailable');
      const job=await response.json();
      if(!(await chrome.storage.local.get("enabled")).enabled)break;
      let result;
      try{
        const tabs=await chrome.tabs.query({url:'https://www.cellartracker.com/*'});
        if(!tabs.length)throw new Error('No CellarTracker tab');
        // A single selected tab per request; never replay a failed request in another tab.
        const tab=tabs.find(t=>t.active)??tabs[0];
        result=await chrome.tabs.sendMessage(tab.id,{type:'cellartracker-request',request:job.request,expiresAt:job.expiresAt});
      }catch{result={error:'Open or reload a signed-in CellarTracker tab.'};}
      await fetch(base+'/result',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({id:job.id,...result}),signal:AbortSignal.timeout(10000)});
    }
  }catch{/* Alarms retry connection, but never replay a dispatched request. */}
  finally{running=false;}
}
chrome.runtime.onInstalled.addListener(()=>{chrome.alarms.create('reconnect',{periodInMinutes:0.5});void connect();});
chrome.runtime.onStartup.addListener(()=>void connect());
chrome.alarms.onAlarm.addListener(()=>void connect());
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id || sender.tab)return;
  if(message?.type==='connect'){void connect();respond({ok:true});}
});
void connect();
