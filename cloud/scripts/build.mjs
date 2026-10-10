import {build} from 'esbuild';
import {mkdir,rm,cp,readFile,writeFile} from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});
await mkdir('dist/server',{recursive:true});
await build({entryPoints:['worker/index.ts'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true});
await mkdir('dist/.openai',{recursive:true});
// Public source uses an unbound example. A deployment's private Site identity is local/ignored.
let hosting;
try{hosting=await readFile('.openai/hosting.json','utf8');}
catch(error){if(error.code!=='ENOENT')throw error;hosting=await readFile('.openai/hosting.example.json','utf8');}
JSON.parse(hosting);
await writeFile('dist/.openai/hosting.json',hosting);
await cp('drizzle','dist/drizzle',{recursive:true});
console.log('Built Worker ESM and schema migrations.');
