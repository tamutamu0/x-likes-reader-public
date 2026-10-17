// Generate private Wrangler configurations without modifying tracked templates.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadDeployment} from './deployment-config.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),api=path.join(root,'apps/api');
const directory=path.join(root,'.cache/cloudflare'),deployment=loadDeployment();
fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
for(const name of ['wrangler.jsonc','wrangler.core.jsonc','wrangler.webhook.jsonc','wrangler.preview.jsonc']){
  const value=JSON.parse(fs.readFileSync(path.join(api,name),'utf8'));
  value.account_id=deployment.accountId;
  value.main=path.join(api,value.main);
  value.$schema=path.join(root,'node_modules/wrangler/config-schema.json');
  delete value.env;
  if(value.assets)value.assets.directory=path.resolve(api,value.assets.directory);
  if(value.vars?.AUTH_ORIGIN)value.vars.AUTH_ORIGIN=deployment.origin;
  if(Object.hasOwn(value.vars ?? {},'X_SYNC_ENABLED')){
    value.vars.X_SYNC_ENABLED=String(deployment.syncEnabled===true);
    value.vars.X_INBOX_PROCESSING_ENABLED=String(deployment.syncEnabled===true);
  }
  for(const database of value.d1_databases ?? []){
    database.database_id=database.binding==='AUTH_DB'?deployment.authDatabaseId:deployment.databaseId;
    database.migrations_dir=path.join(api,database.migrations_dir);
  }
  const file=path.join(directory,name);
  fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.chmodSync(file,0o600);
}
console.log('Prepared private Wrangler configurations under .cache/cloudflare/; nothing deployed.');
