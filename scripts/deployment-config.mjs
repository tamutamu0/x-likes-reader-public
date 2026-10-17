// Local administration only. Runtime MCP clients never read this file.
import fs from 'node:fs';
import {readerOrigin} from '../packages/contracts/mcp-reader.mjs';
export function loadDeployment(file=new URL('../.cache/cloudflare/deployment.json',import.meta.url)) {
  let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('deployment_configuration_missing');}
  if(!value||!/^[a-f0-9]{32}$/.test(value.accountId)||
    ![value.databaseId,value.authDatabaseId].every(id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id)))throw Error('deployment_configuration_invalid');
  readerOrigin(value.origin);readerOrigin(value.webhookOrigin);
  if(typeof value.creditStopAt!=='string'||!Number.isFinite(Date.parse(value.creditStopAt)))throw Error('deployment_configuration_invalid');
  return value;
}
