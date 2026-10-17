import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
const message=document.querySelector<HTMLElement>('#message')!;
const primary=document.querySelector<HTMLButtonElement>('#primary')!;
async function post(path:string,body:unknown={}) {
  const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Margin-Request':'1'},body:JSON.stringify(body),redirect:'error'});
  if(!r.ok)throw new Error('認証できませんでした。もう一度お試しください。');
  return r.json();
}
let setupReady=Promise.resolve();
let ownerLink='';
if(primary.dataset.action==='link') {
  ownerLink=location.hash.slice(1);history.replaceState(null,'',location.pathname);
  if(!/^[A-Za-z0-9_-]{43}$/.test(ownerLink)){message.textContent='本人用リンクから開いてください。リンクが期限切れならMacから新しく発行できます。';primary.disabled=true;}
}
if(primary.dataset.action==='register') {
  const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
  if(token)setupReady=post('/auth/setup/exchange',{token}).then(()=>undefined);
  setupReady.catch(()=>{message.textContent='登録リンクは期限切れか使用済みです。Macから登録をやり直してください。';primary.disabled=true;});
}
async function act(button:HTMLButtonElement) {
  button.disabled=true;
  try {
    await setupReady;
    const action=button.dataset.action;
    if(action==='link'){await post('/auth/link/exchange',{token:ownerLink});ownerLink='';location.replace('/');return;}
    if(action==='logout' || action==='logout-all') {await post('/auth/'+action);location.replace('/auth/login');return;}
    const kind=action==='register'?'register':'login';
    const optionsJSON=await post('/auth/'+kind+'/options');
    const credential=kind==='register'?await startRegistration({optionsJSON}):await startAuthentication({optionsJSON});
    await post('/auth/'+kind+'/verify',credential);location.replace('/');
  } catch { message.textContent='認証を完了できませんでした。Touch IDや端末のロック解除で、もう一度お試しください。';button.disabled=false; }
}
primary.addEventListener('click',()=>act(primary));
document.querySelector<HTMLButtonElement>('#all')?.addEventListener('click',e=>act(e.currentTarget as HTMLButtonElement));
