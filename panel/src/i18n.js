import messages from '../../shared/translations.json';
import {languages,resolveLanguage,saveLanguage} from './locale.js';
let preference='auto';
try { preference=localStorage.getItem('mdtl.language')??'auto'; } catch { /* Storage may be blocked in an iframe. */ }
const detected=()=>navigator.languages??[navigator.language]; // Use browser language priority.
export function language(){ return resolveLanguage(preference,detected()); } // Resolve system changes on every render.
export function t(key,value='') { // Substitute data as text; translations never supply HTML.
  const index=Object.keys(languages).indexOf(language());
  return (messages[key]?.[index]??messages[key]?.[0]??messages.unavailable[index]).replaceAll('{value}',String(value));
}
export function installLanguagePicker(onChange=()=>{}) { // One accessible picker serves each extension page.
  const select=document.createElement('select');select.id='language';
  for(const [value,label] of [['auto',t('auto')],...Object.entries(languages)])select.add(new Option(label,value));
  select.value=Object.hasOwn(languages,preference)?preference:'auto';
  document.querySelector('header').after(select);
  function update(){ // Refresh static text and let the caller redraw current dynamic state.
    document.documentElement.lang=language();select.setAttribute('aria-label',t('language'));
    select.options[0].textContent=t('auto');
    document.querySelectorAll('[data-i18n]').forEach(node=>{node.textContent=t(node.dataset.i18n);});
    onChange();
  }
  select.addEventListener('change',()=>{preference=select.value;try{saveLanguage(localStorage,preference);}catch{/* Keep the session choice. */}update();});
  window.addEventListener('languagechange',update);update();
}
