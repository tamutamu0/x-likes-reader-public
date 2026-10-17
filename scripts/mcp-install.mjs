// User-wide registration, no credentials copied into client config or command line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url)),name='x-likes-reader',entry=path.join(root,'apps/mcp/src/server.mjs');
const legacy=process.argv[2]==='--rename-from'?process.argv[3]:null;
if(legacy && (!/^[A-Za-z0-9_-]+$/.test(legacy)||legacy===name))throw Error('invalid_legacy_name');
const node=fs.existsSync('/opt/homebrew/bin/node')?'/opt/homebrew/bin/node':process.execPath;
const privateDir=path.join(root,'.cache/mcp'),backupDir=path.join(privateDir,'config-backups');
fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const credential=client=>path.join(privateDir,client+'.json');
for(const client of ['codex','claude-code','claude-desktop'])if(!fs.existsSync(credential(client)))throw Error('issue_credentials_first');
const targets=[['codex',path.join(os.homedir(),'.codex/config.toml')],['claude-code',path.join(os.homedir(),'.claude.json')],['claude-desktop',path.join(os.homedir(),'Library/Application Support/Claude/claude_desktop_config.json')]];
for(const [client,file] of targets)if(fs.existsSync(file))fs.writeFileSync(path.join(backupDir,client+'-'+stamp+'.backup'),fs.readFileSync(file),{mode:0o600,flag:'wx'});
function run(command,args){const p=spawnSync(command,args,{encoding:'utf8',stdio:'pipe'});if(p.status!==0)throw Error('client_registration_failed_'+command);}
run('codex',['mcp','add',name,'--',node,entry,'--credentials',credential('codex')]);
run('claude',['mcp','add','--scope','user','--transport','stdio',name,'--',node,entry,'--credentials',credential('claude-code')]);
const file=targets[2][1],config=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
config.mcpServers??={};config.mcpServers[name]={command:node,args:[entry,'--credentials',credential('claude-desktop')]};
if(legacy && config.mcpServers[legacy]){
 if(!config.mcpServers[legacy].args?.includes(entry))throw Error('legacy_entry_conflict');
 delete config.mcpServers[legacy];
}
fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=file+'.margin-'+stamp+'.tmp';
fs.writeFileSync(temporary,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);
if(legacy){
 for(const command of ['codex','claude']){
  const existing=spawnSync(command,['mcp','get',legacy],{encoding:'utf8',stdio:'pipe'});
  if(existing.status===0){if(!existing.stdout.includes(entry))throw Error('legacy_entry_conflict');
   run(command,['mcp','remove',legacy,...(command==='claude'?['--scope','user']:[])]);
  }
 }
}
console.log(JSON.stringify({registered:true,name,...(legacy?{renamedFrom:legacy}:{}),clients:targets.map(t=>t[0]),scope:'all_projects_on_this_mac',credentialsInConfig:false,restartClientsToLoad:true}));
