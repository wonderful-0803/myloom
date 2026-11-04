/** One in-flight snapshot request, with bounded waits and refreshes across embedded-tab visibility changes. */
export function startLiveSync<T>(options:{load:(signal:AbortSignal)=>Promise<T>;value:(value:T)=>void;error:(error:unknown)=>void;interval?:number;timeout?:number}){
  let stopped=false,pending:Promise<void>|undefined,controller:AbortController|undefined;
  const refresh=():Promise<void>=>{
    if(stopped)return Promise.resolve();
    if(pending)return pending;
    controller=new AbortController();const active=controller;
    const timeout=setTimeout(()=>active.abort(),options.timeout??10000);
    pending=Promise.resolve().then(()=>options.load(active.signal)).then(value=>{if(!stopped)options.value(value);},error=>{if(!stopped)options.error(error);})
      .finally(()=>{clearTimeout(timeout);pending=undefined;});
    return pending;
  };
  const changed=()=>{void refresh();};
  const interval=setInterval(changed,options.interval??3000);
  window.addEventListener('focus',changed);window.addEventListener('hashchange',changed);document.addEventListener('visibilitychange',changed);
  void refresh();
  return {refresh,stop:()=>{stopped=true;clearInterval(interval);controller?.abort();window.removeEventListener('focus',changed);window.removeEventListener('hashchange',changed);document.removeEventListener('visibilitychange',changed);}};
}
