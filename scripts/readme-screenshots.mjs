// Capture the actual UI with built-in fictional samples in fresh browser contexts.
// No existing browser profile, X connection, credentials or personal database is used.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDemoServer} from './demo.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const root=fileURLToPath(new URL('../',import.meta.url)),out=path.join(root,'docs/images');
const server=createDemoServer({directory:process.env.DOCS_WEB_ROOT||path.join(root,'stable/public')});
await new Promise(resolve=>server.once('listening',resolve));
const origin='http://127.0.0.1:'+server.address().port;
let browser;
const external=[],errors=[],captures=[];
try{
  await fs.mkdir(out,{recursive:true});
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
  for(const scenario of [
    {name:'desktop-library',width:1440,height:1080,mode:'library'},
    {name:'desktop-reading',width:1440,height:1000,mode:'reading'},
    {name:'mobile-reading',width:390,height:844,mode:'reading',mobile:true},
  ]){
    const context=await browser.newContext({viewport:{width:scenario.width,height:scenario.height},deviceScaleFactor:1,colorScheme:'light',locale:'ja-JP',timezoneId:'UTC',reducedMotion:'reduce',...(scenario.mobile?{isMobile:true,hasTouch:true}:{})});
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin===origin)return route.continue();
      external.push(url.origin);return route.abort();
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.clock.install({time:new Date('2026-01-15T12:00:00Z')});
    await page.goto(origin,{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'サンプルで試す',exact:true}).click();
    await page.locator('#main article.post').first().waitFor();
    if(scenario.mode==='library'){
      await page.keyboard.press('2');
    }else{
      // The built-in SQLite example is fictional, with a reserved .example URL.
      const post=page.locator('#main article.post').filter({hasText:'個人ツールのデータは SQLite'}).first();
      await post.locator('.text').click();
      await page.locator('article.detail').waitFor();
      await page.getByRole('textbox',{name:'メモ',exact:true}).fill('次の架空プロジェクトで試す。まずローカル保存を作り、バックアップから戻せることまで確かめる。');
      await page.getByRole('textbox',{name:'メモ',exact:true}).blur();
    }
    await page.clock.runFor(7000); // Let transient insertion notices disappear.
    await page.evaluate(async()=>{await document.fonts.ready;window.scrollTo(0,0);});
    await page.waitForTimeout(100);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    if(overflow)throw Error('Screenshot has horizontal overflow: '+scenario.name);
    const fictional=await page.locator('.fict,.flag').filter({hasText:'架空'}).count();
    if(!fictional)throw Error('Fictional sample marker is missing.');
    const file=path.join(out,scenario.name+'.png');
    await page.screenshot({path:file,animations:'disabled'});
    captures.push({file:'docs/images/'+scenario.name+'.png',width:scenario.width,height:scenario.height,fictional:true});
    await context.close();
  }
  if(external.length||errors.length)throw Error('Screenshot isolation/console verification failed.');
  await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({source:'Built-in fictional samples in stable/public/js/sample.js',realAccountData:false,externalRequests:0,captures},null,2)+'\n');
  console.log('Captured 3 screenshots: fictional samples only, fresh contexts, external requests 0.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
