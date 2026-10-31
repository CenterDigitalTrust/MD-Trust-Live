import './style.css';
import {api,authorize} from './api.js';
import {t,installLanguagePicker,language} from './i18n.js';
const button=document.getElementById('pair'),message=document.getElementById('message');
let authorized=false,expires=null,failed=false;
function renderMessage(){ // Preserve the current pairing state when changing languages.
  message.textContent=failed?t('failed'):expires?t('expires',new Date(expires).toLocaleTimeString(language())):t(authorized?'ready':'auth');
}
installLanguagePicker(renderMessage);
window.Twitch?.ext.onAuthorized(auth=>{ // Server still enforces broadcaster role.
  authorize(auth.token);authorized=true;button.disabled=false;renderMessage();
});
button.addEventListener('click',async()=>{ // Avoid duplicate clicks and show recoverable errors.
  button.disabled=true;
  try{const result=await api('/v1/pair/code',{});document.getElementById('code').textContent=result.code;expires=result.expires_at;failed=false;}
  catch(error){failed=true;}
  finally{button.disabled=false;renderMessage();}
});
