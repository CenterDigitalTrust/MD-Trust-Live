import './style.css';
import {api,authorize} from './api.js';
import {t,installLanguagePicker,language} from './i18n.js';
const $=id=>document.getElementById(id);
let active='proof',timer,failures=0;
let lastState=null,lastDrop=null;
const labels={VERIFIED_LIVE:'verified',DATA_MISMATCH:'mismatch',WAITING:'waiting',OFFLINE:'offline',SIMULATED:'simulated'};
function render(state){ // Text labels accompany colors for accessible state reporting.
  lastState=state;
  $('app').className={VERIFIED_LIVE:'verified',DATA_MISMATCH:'mismatch',WAITING:'waiting',SIMULATED:'simulated'}[state.status]??'';
  $('status').textContent=t(labels[state.status]??'unavailable');
  $('caption').textContent=t(state.connectionFailed?'retry':labels[state.status]??'waiting');
  $('pulse').textContent=state.last_pulse_at?t('ago',Math.max(0,Math.floor((Date.now()-state.last_pulse_at)/1000))):'—';
  $('seq').textContent=state.seq>=0?String(state.seq+1):'—';
  $('session').textContent=state.session_id??'—';$('hash').textContent=state.head_hash??'—';$('time').textContent=state.server_time?new Date(state.server_time).toLocaleString(language()):'—';
}
async function poll(){ // Back off after errors and remove any stale green immediately.
  clearTimeout(timer);
  try{render(await api('/v1/state'));if(active==='drop')await refreshDrop();failures=0;}catch(error){failures++;clearDrop();render({status:'WAITING',connectionFailed:true});}
  timer=setTimeout(poll,Math.min(30000,3000*2**Math.min(failures,3)));
}
for(const button of document.querySelectorAll('.tab'))button.addEventListener('click',()=>{
  // Switch only local views; service features remain disabled until available.
  active=button.dataset.tab;
  for(const tab of document.querySelectorAll('.tab'))tab.classList.toggle('active',tab===button);
  for(const view of document.querySelectorAll('.view'))view.hidden=view.id!==active;
  if(active==='drop')refreshDrop().catch(()=>{clearDrop();});
});
function clearDrop(){ // Remove stale results whenever current evidence cannot be fetched.
  lastDrop=null;$('enter').disabled=true;$('math').textContent=t('retry');
  $('drop-message').textContent=t('unavailable');$('prize').textContent=t('waiting');
  $('entries').textContent='—';
}
async function refreshDrop(){ // Render only verified API data using text nodes.
  const data=await api('/v1/giveaway');
  renderDrop(data);
}
function renderDrop(data){ // Redraw cached verified data when language changes, without a network request.
  lastDrop=data;
  $('prize').textContent=data.prize??t('noDrop');
  $('entries').textContent=new Intl.NumberFormat(language()).format(data.entries_count??0);
  $('enter').disabled=data.state!=='OPEN'||data.you_entered===true;
  $('enter').textContent=t(data.you_entered?'joined':'join');
  $('drop-message').textContent=data.state==='COMPLETE'?t('winner',data.winner_user_key):t(data.state??'NONE');
  $('math').textContent=data.state==='COMPLETE'?JSON.stringify({algorithm:'MDTL-DRAW-1',seed:data.seed,root:data.entries_hash,count:data.entries_count,index:data.winner_index,winner:data.winner_user_key,proof:data.winner_proof},null,2):t('afterDraw');
}
$('enter').addEventListener('click',async()=>{ // Twitch controls identity consent; never fabricate a viewer ID.
  try{
    if(!window.Twitch?.ext.viewer.isLinked){window.Twitch?.ext.actions.requestIdShare();$('drop-message').textContent=t('share');return;}
    $('enter').disabled=true;await api('/v1/giveaway/enter',{});await refreshDrop();
  }catch(error){$('drop-message').textContent=t('failed');$('enter').disabled=false;}
});
installLanguagePicker(()=>{if(lastState)render(lastState);if(lastDrop)renderDrop(lastDrop);});
window.Twitch?.ext.onAuthorized(auth=>{authorize(auth.token);poll();});
document.addEventListener('visibilitychange',()=>{ // Reduce hidden-frame traffic.
  if(document.hidden)clearTimeout(timer);else poll();
});
if(import.meta.env.DEV&&new URLSearchParams(location.search).has('preview'))render({status:'SIMULATED',seq:127,head_hash:'8f4bc1e07d6a3c9e'.repeat(4),session_id:'Design preview',last_pulse_at:Date.now(),server_time:Date.now()});
