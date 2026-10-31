import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
// @ts-expect-error Browser module deliberately has no server-side TypeScript dependency.
import {languages,resolveLanguage,readLanguage,saveLanguage} from '../../panel/src/locale.js';

test('seven locales resolve regional variants, explicit preferences and fallback',()=>{
  // Cover real browser language forms and unsupported preferences.
  assert.deepEqual(Object.keys(languages),['en','es','de','fr','ru','uk','ja']);
  assert.equal(resolveLanguage(null,['pt-BR','uk-UA']),'uk');
  assert.equal(resolveLanguage(null,['JA_jp']),'ja');
  assert.equal(resolveLanguage('fr',['de-DE']),'fr');
  assert.equal(resolveLanguage('__proto__',['ru-RU']),'ru');
  assert.equal(resolveLanguage(null,['zh-CN']),'en');
});

test('blocked browser storage preserves detection and manual choice can reset',()=>{
  // Third-party iframe storage failures must not crash onboarding.
  const blocked={getItem(){throw new Error('Storage denied');},setItem(){throw new Error('Storage denied');}};
  assert.equal(readLanguage(blocked,['es-MX']),'es');
  assert.equal(saveLanguage(blocked,'de'),false);
  const data=new Map<string,string>();
  const storage={getItem:(key:string)=>data.get(key),setItem:(key:string,value:string)=>data.set(key,value),removeItem:(key:string)=>data.delete(key)};
  assert.equal(saveLanguage(storage,'ja'),true);
  assert.equal(readLanguage(storage,['en-US']),'ja');
  assert.equal(saveLanguage(storage,'auto'),true);
  assert.equal(readLanguage(storage,['en-US']),'en');
});

test('all seven catalogs preserve interpolation fields and match generated Android catalog',async()=>{
  // Prevent missing translations and mismatched runtime substitutions in either client.
  const raw=await readFile(new URL('../../shared/translations.json',import.meta.url),'utf8');
  const catalog=JSON.parse(raw) as Record<string,string[]>;
  for(const [key,values] of Object.entries(catalog)) {
    assert.equal(values.length,7,key);
    const fields=(value:string)=>[...value.matchAll(/\{[a-z]+\}/g)].map(match=>match[0]).sort();
    for(const value of values){assert.ok(value.trim(),key);assert.deepEqual(fields(value),fields(values[0]),key);}
  }
  const dart=await readFile(new URL('../../app/lib/l10n/messages.dart',import.meta.url),'utf8');
  assert.ok(dart.includes(JSON.stringify(catalog,null,2)),'Regenerate Android translations');
});
