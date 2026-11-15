#!/usr/bin/env node
/** Execute the actual VSIX on its native host. Model transport is a stand-in; no paid calls. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'packages/mcp/package.json'));
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const archive=path.resolve(process.argv[2]??'');
assert(archive.endsWith('.vsix'),'Pass the platform VSIX path');
const target=`${process.platform==='win32'?'win32':process.platform==='darwin'?'darwin':'linux'}-${process.arch==='arm64'?'arm64':'x64'}`;
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'cgg complete package '));
const ext=path.join(tmp,'extension'),project=path.join(tmp,'project');
const hostPython=process.env.CGG_BUILD_PYTHON??(process.platform==='win32'?'python':'python3');
let client;
const invoke=(command,args,options={})=>{const p=spawnSync(command,args,{encoding:'utf8',timeout:90000,...options});assert.equal(p.status,0,`${command}: ${p.stderr||p.error||p.stdout}`);return p.stdout;};
try{
 invoke(hostPython,['-c','import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',archive,tmp]);
 const manifest=JSON.parse(await fs.readFile(path.join(ext,'package.json'),'utf8'));
 const exe=process.platform==='win32'?'.exe':'';
 const hook=path.join(ext,'bin','goal-guardian-hook'+exe),mcp=path.join(ext,'bin','goal-guardian-mcp'+exe),codex=path.join(ext,'bin','goal-guardian-codex-goals'+exe);
 const python=path.join(ext,'bin','python',process.platform==='win32'?'python.exe':'bin/python3');
 for(const f of [hook,mcp,codex,python]){assert((await fs.stat(f)).isFile(),f);if(process.platform!=='win32')await fs.chmod(f,0o755);}
 // Deliberately use the installed component layout, not source-tree evaluator/Codex overrides.
 const env={...process.env};
 for(const k of Object.keys(env))if(k.startsWith('GOAL_GUARDIAN_')||k.startsWith('CGG_'))delete env[k];
 const model=path.join(tmp,'model.cjs'),log=path.join(tmp,'model-calls.jsonl');
 await fs.writeFile(model,`const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),ws=args[args.indexOf('--workspace')+1];let text=args[args.indexOf('-p')+1]||'';
if(text.startsWith('Read task.md'))text=fs.readFileSync(path.join(ws,'task.md'),'utf8');
if(text.startsWith('Read .cursor/goal-guardian/review-task.md'))text=fs.readFileSync(path.join(ws,'.cursor/goal-guardian/review-task.md'),'utf8');
assertUnicode(text);
function assertUnicode(text){if(!text.includes('日本語'))throw Error('Unicode request context was corrupted');}
const rsi=text.includes('CGG_PACKAGE_RRSI_TRANSPORT'),judge=args.includes('--mode');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({role:rsi?'rrsi':judge?'adk':'reviewer'})+'\\n');
const answer=rsi?JSON.stringify({platform_transport:'ok 日本語'}):judge?['sc_1','extra'].map(id=>'ID: '+id+'\\nProperty: fixture\\nRationale: offline transport check.\\nVerdict: yes').join('\\n\\n'):JSON.stringify({items:[{id:'sc_1',verdict:'holds',evidence:'Offline transport stand-in; fixture oracle tests passed.'}],extra:[],checks:[{id:'build',verdict:'not_applicable',evidence:'Source-only fixture with no build step.'},{id:'public_api',verdict:'holds',evidence:'Fixture oracle imported subtract.'},{id:'behavior',verdict:'holds',evidence:'Fixture oracle checked subtract(5,2)===3.'}]});
console.log(JSON.stringify({type:'result',result:answer}));`);
 const launcher=path.join(tmp,process.platform==='win32'?'cursor-agent.cmd':'cursor-agent');
 await fs.writeFile(launcher,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${model}" %*\r\n`:`#!/usr/bin/env node\nrequire(${JSON.stringify(model)});\n`);
 if(process.platform!=='win32')await fs.chmod(launcher,0o755);
 env.GOAL_GUARDIAN_REVIEWER=launcher;env.GOAL_GUARDIAN_WORKSPACE_ROOT=project;
 await fs.mkdir(project);
 const git=(...args)=>invoke('git',args,{cwd:project,env});
 git('init','-q');await fs.writeFile(path.join(project,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test test.mjs'}}));
 await fs.writeFile(path.join(project,'index.js'),'export const base = x => x;\n');
 git('add','.');git('-c','user.name=CGG package check','-c','user.email=check@localhost','-c','commit.gpgsign=false','commit','-qm','Fixture base');
 const callHook=payload=>JSON.parse(invoke(hook,[],{input:JSON.stringify({workspace_roots:[project],cwd:project,conversation_id:'platform-check',generation_id:'one',...payload}),env,cwd:project}));
 const request='Add subtract(a,b) to this package (日本語).\nDone when:\n1. Export subtract and test its behavior.';
 callHook({hook_event_name:'beforeSubmitPrompt',prompt:request,composer_mode:'agent'});
 client=new Client({name:'cgg-complete-package',version:'1.0.0'});
 await client.connect(new StdioClientTransport({command:mcp,args:[],env,stderr:'pipe'}));
 const tools=await client.listTools();assert.equal(tools.tools.length,6);
 const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);};
 await call('create_goal',{objective:request});
 await call('guardian_change_goal',{add_criteria:['Export subtract and test its behavior.']});
 await fs.appendFile(path.join(project,'index.js'),'export const subtract = (a,b) => a-b;\n');
 await fs.writeFile(path.join(project,'test.mjs'),"import assert from 'node:assert/strict';import {subtract,base} from './index.js';assert.equal(subtract(5,2),3);assert.equal(base('x'),'x');\n");
 callHook({hook_event_name:'afterFileEdit',file_path:path.join(project,'index.js')});
 callHook({hook_event_name:'afterFileEdit',file_path:path.join(project,'test.mjs')});
 const continuation=callHook({hook_event_name:'stop',status:'completed',loop_count:0});
 assert.equal(typeof continuation.followup_message,'string',JSON.stringify(continuation));
 assert(continuation.followup_message.includes('Add subtract(a,b)'),JSON.stringify(continuation));
 const output=invoke(process.execPath,['--test','test.mjs'],{cwd:project,env});
 callHook({hook_event_name:'beforeShellExecution',command:'node --test test.mjs'});
 callHook({hook_event_name:'afterShellExecution',command:'node --test test.mjs',output,duration:1});
 const completed=await call('update_goal',{status:'complete'});assert.equal(completed.outcome,'proved',JSON.stringify(completed));
 const state=await call('get_goal',{});assert.equal(state.goal.status,'complete');assert('codex' in state,'Native Codex handler answer missing');
 const finished=callHook({hook_event_name:'stop',status:'completed',loop_count:1});
 assert(!finished.followup_message,JSON.stringify(finished));
 // Actual bundled Python + RRSI transport, isolated from developer site packages.
 const script=`import sys,json\nsys.path[:0]=sys.argv[1:4]\nimport rrsi.selection,rrsi.domain,cursor_llm\nanswer=cursor_llm.generate('CGG_PACKAGE_RRSI_TRANSPORT 日本語',json_only=True,max_retries=1)\nassert json.loads(answer)['platform_transport']=='ok 日本語'\nprint('rrsi transport ok')`;
 invoke(python,['-I','-S','-c',script,path.join(ext,'rsi','rrsi'),path.join(ext,'rsi','cgg'),path.join(ext,'evaluator','site-packages')],{env,cwd:tmp});
 const roles=(await fs.readFile(log,'utf8')).trim().split('\n').map(x=>JSON.parse(x).role);
 for(const role of ['reviewer','adk','rrsi'])assert(roles.includes(role),role+' transport did not execute');
 const receipt={version:manifest.version,target,source_commit:process.env.GITHUB_SHA??null,sha256:createHash('sha256').update(await fs.readFile(archive)).digest('hex'),components:{native_codex:true,goal_loop:true,project_review_transport:true,adk_evaluation:true,rrsi_transport:true},scope:'Native complete-package integration with stand-in model transport; not real-model accuracy or Cursor desktop delivery.'};
 await fs.writeFile(archive+'.verified.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await client?.close();await fs.rm(tmp,{recursive:true,force:true});}
