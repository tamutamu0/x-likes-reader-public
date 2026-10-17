import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { URL } from 'node:url';
export function database(auth=false) {
  const sqlite=new DatabaseSync(':memory:');
  const dir=auth?'auth-migrations':'migrations';
  for (const file of readdirSync(new URL('../'+dir+'/',import.meta.url)).filter(s=>s.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL('../'+dir+'/'+file,import.meta.url),'utf8'));
  const prepare=(sql:string)=>{
    let args:(string|number|null)[]=[];
    const s={bind(...values:(string|number|null)[]){args=values;return s;},
      async first(){return sqlite.prepare(sql).get(...args) ?? null;},
      async all(){return {success:true,results:sqlite.prepare(sql).all(...args)};},
      async run(){const stmt=sqlite.prepare(sql); const returning=/\bRETURNING\b/i.test(sql);return {success:true,results:returning ? stmt.all(...args): (stmt.run(...args),[])};}};
    return s;
  };
  let queue=Promise.resolve();
  const db={prepare,batch(statements:ReturnType<typeof prepare>[]){
    const job=queue.then(async()=>{sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}});
    queue=job.then(()=>undefined,()=>undefined);return job;
  }} as unknown as D1Database;
  return {db,sqlite};
}
