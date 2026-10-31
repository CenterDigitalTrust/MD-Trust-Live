import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,join,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=resolve(fileURLToPath(new URL('../panel/dist/',import.meta.url)));
const work=resolve(process.argv[2]??'.browser-check');
const browser=process.env.CHROME_PATH??'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const languages=['en','es','de','fr','ru','uk','ja'];
let server,child;
try {
  // Run a hermetic visual fixture in a separate browser profile; no Twitch account is accessed.
  await mkdir(work,{recursive:true});
  const messages=JSON.parse(await readFile(new URL('../shared/translations.json',import.meta.url),'utf8'));
  let reportResolve;
  const report=new Promise(resolve=>{reportResolve=resolve;});
  const fixture=`<script>
  const messages=${JSON.stringify(messages)},languages=${JSON.stringify(languages)};
  window.Twitch={ext:{onAuthorized:callback=>callback({token:'fixture-only'}),viewer:{isLinked:true},actions:{}}};
  window.fetch=async()=>({ok:true,json:async()=>({status:'SIMULATED',seq:3,session_id:'UI fixture',head_hash:'ab'.repeat(32),server_time:Date.now(),last_pulse_at:Date.now(),state:'OPEN',prize:'Fixture prize',entries_count:3})});
  addEventListener('load',async()=>{
    const errors=[];
    try {
      const picker=document.querySelector('#language');if(!picker)throw Error('Language picker missing');
      for(const [index,language] of languages.entries()){
        picker.value=language;picker.dispatchEvent(new Event('change'));
        if(document.documentElement.lang!==language)errors.push(language+': document language');
        for(const element of document.querySelectorAll('[data-i18n]')){
          if(['status','caption','prize','enter','drop-message','math','message'].includes(element.id))continue;
          if(element.textContent!==messages[element.dataset.i18n][index])errors.push(language+': '+element.dataset.i18n);
        }
        if(localStorage.getItem('mdtl.language')!==language)errors.push(language+': persistence');
        if(document.documentElement.scrollWidth>innerWidth)errors.push(language+': horizontal overflow');
      }
      picker.value='ru';picker.dispatchEvent(new Event('change'));
    } catch(error){errors.push(error.message);}
    navigator.sendBeacon('/results',JSON.stringify({errors,languages:languages.length}));
  });</script>`;
  server=createServer(async(request,response)=>{
    // Serve only built assets and collect the isolated page's assertions.
    try {
      if(request.url==='/results'){
        let body='';for await(const chunk of request){body+=chunk;if(body.length>20000)throw Error('Oversized result');}
        reportResolve(JSON.parse(body));response.end('ok');return;
      }
      const pathname=new URL(request.url,'http://localhost').pathname;
      const file=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
      if(!file.startsWith(root+sep))throw Error('Invalid asset path');
      let content=await readFile(file);
      if(extname(file)==='.html')content=Buffer.from(content.toString().replace('<script src="https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js"></script>',fixture));
      response.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css'})[extname(file)]??'application/octet-stream');
      response.end(content);
    } catch {response.statusCode=404;response.end('Asset unavailable');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  child=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--user-data-dir='+join(work,'profile'),'--window-size=640,720','--virtual-time-budget=10000','--screenshot='+join(work,'panel-ru.png'),`http://127.0.0.1:${address.port}/`],{windowsHide:true,stdio:'ignore'});
  const result=await Promise.race([report,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Browser assertions timed out')),120000);timer.unref();}),new Promise((_,reject)=>child.once('error',reject))]);
  if(result.errors.length)throw Error(result.errors.join('; '));
  await Promise.race([new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve)),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Browser exit timed out')),30000);timer.unref();})]);
  console.info(JSON.stringify({status:'PASS',...result,screenshot:join(work,'panel-ru.png'),fixture:true}));
} catch(error){console.error('Browser check failed:',error.message);process.exitCode=1;}
finally {if(child?.exitCode===null)child.kill();if(server)server.close();}
