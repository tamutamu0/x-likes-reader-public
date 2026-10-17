// Credential-free documentation preview. Never imports the real X service or env files.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const publicDirectory=fileURLToPath(new URL('../stable/public/',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
export function createDemoServer({port=0,directory=publicDirectory}={}) {
  const server=http.createServer(async(req,res)=>{
    const send=(status,type,body)=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(body);};
    const json=value=>send(200,'application/json',JSON.stringify(value));
    if(req.method!=='GET')return send(405,'text/plain','Demo is read-only at the server.');
    let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);}catch{return send(400,'text/plain','Bad request');}
    if(pathname==='/api/health')return json({ok:true,app:'margin',demo:true,xLikes:'not_connected',jsonFileIO:'awaiting_approval',fetchMode:'disabled'});
    if(pathname==='/api/x/status')return json({status:'ok',configured:false,connected:false});
    if(pathname==='/api/x/items')return json({status:'ok',revision:0,entries:[]});
    // No article/image proxy, cloud connection, labels, credentials, or data files.
    if(pathname.startsWith('/api/'))return send(404,'text/plain','Not available in demo');
    const relative=pathname==='/'?'index.html':pathname.slice(1);
    if(relative!=='index.html'&&!/^(?:css|js|samples)\/[a-zA-Z0-9_./-]+$/.test(relative))return send(404,'text/plain','Not found');
    const file=path.resolve(directory,relative),base=path.resolve(directory)+path.sep;
    if(!file.startsWith(base)||!types[path.extname(file)])return send(404,'text/plain','Not found');
    try{
      const real=await fs.realpath(file);if(!real.startsWith(base))return send(404,'text/plain','Not found');
      send(200,types[path.extname(file)],await fs.readFile(real));
    }catch{send(404,'text/plain','Not found');}
  });
  server.listen(port,'127.0.0.1');
  return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const server=createDemoServer({port:Number(process.env.DEMO_PORT||47323)});
  server.on('listening',()=>console.log(`Fictional-data demo: http://127.0.0.1:${server.address().port} — choose サンプルで試す`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close());
}
