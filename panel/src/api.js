import {t} from './i18n.js';
export const API=import.meta.env.VITE_EBS_URL??'https://api.digitaltrust.living/twitch';
let token='';
export function authorize(value){ // Keep refreshed Twitch JWT only in memory.
  token=value;
}
export async function api(path,body){ // Bound requests and handle malformed server replies.
  if(!token)throw new Error(t('auth'));
  try{
    const response=await fetch(API+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(7000)});
    const data=await response.json();
    if(!response.ok)throw new Error(t('failed'));
    return data;
  }catch(error){throw new Error(error instanceof Error?error.message:t('retry'));}
}
