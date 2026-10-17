import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
await build({absWorkingDir:root,entryPoints:['apps/api/client/auth.ts'],bundle:true,format:'iife',platform:'browser',target:['safari17','chrome120'],minify:true,outfile:'apps/api/dist/auth-client.txt'});
