#!/usr/bin/env node
/** Regenerate public illustrations from current production panel markup. No model calls. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {buildPanelViewModel,defaultContract,goalHash,GUARDIAN_SKILLS} from '../packages/core/dist/index.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ext=path.join(root,'packages/cursor-goal-guardian-extension');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cgg-public-media-'));
try {
 await build({entryPoints:[path.join(ext,'src/panel/render.ts')],outfile:path.join(temp,'render.mjs'),bundle:true,platform:'node',format:'esm'});
 const {renderSections}=await import(path.join(temp,'render.mjs'));
 const manifest=JSON.parse(await fs.readFile(path.join(ext,'package.json'),'utf8'));
 const css=await fs.readFile(path.join(ext,'media/panel.css'),'utf8');
 const js=await fs.readFile(path.join(ext,'media/webview.js'),'utf8');
 const icon='data:image/png;base64,'+(await fs.readFile(path.join(ext,'images/icon.png'))).toString('base64');
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const contract={...defaultContract(),goal:'Ship CSV export with filters and tests',successCriteria:[{id:'sc_1',text:'Export the filtered rows as CSV'},{id:'sc_2',text:'Keep the public API working'},{id:'sc_3',text:'Add behavioral tests and usage docs'}],constraints:['No new dependencies']};
 const hash=goalHash(contract),time='2026-11-15T00:00:00.000Z';
 const round={ts:time,kind:'goal.round',conversationId:'illustration',goalHash:hash,round:2,idle:false,unproved:['Finish the public CSV export and its focused regression check.'],unclaimed:[],extras:[]};
 const review={ts:time,kind:'goal.review',id:'example_review',goalHash:hash,reportTs:time,ran:true,seconds:0,fails:[{id:'sc_2',evidence:'The CSV helper works in its source file but is missing from the advertised package entry point.'}],extra:[]};
 const end={ts:time,kind:'goal.end',goalHash:hash,conversationId:'illustration',outcome:'proved',proved:contract.successCriteria.map(c=>({criterion:c.id,command:'example check',quote:'passing — illustrative data'})),rounds:3};
 function vm(records=[],extra={}){return buildPanelViewModel({setUp:true,contract,records,goalRecords:records,now:new Date(time),tourDismissed:true,...extra});}
 const scenes={
  welcome:{title:'Start with the work.',body:'Connect with a goal now, or ask your agent normally after setup.',vm:vm([],{setUp:false})},
  setup:{title:'Connect once. Then work.',body:'Goal, finish conditions and boundaries are optional and editable later.',vm:vm([],{setUp:false}),fill:true},
  active:{title:'Keep the goal in view.',body:'The agent gets the goal, previous checks and concrete remaining work.',vm:vm([round])},
  review:{title:'Catch what is unfinished.',body:'A missing public export is useful feedback. Supporting tests, types and docs belong to the work.',vm:vm([review,{...round,reviewer:['Reviewer: sc_2 is not done: the package export is missing.']}])},
  corrected:{title:'Correct a specific finding.',body:'Feedback helps the next check and is retained for eligible RRSI learning.',vm:vm([{...review,fails:[],extra:[{file:'index.d.ts',what:'A supporting CSV type declaration was called unrelated.'}]},{ts:time,kind:'review.feedback',reviewId:'example_review',index:0,label:'wrong',source:'panel'}])},
  complete:{title:'Finish. Check. Move on.',body:'The completion state distinguishes passing checks from incomplete verification.',vm:vm([end])},
  pivot:{title:'Your words steer the goal.',body:'Change direction in chat; a temporary stop leaves the full goal available for later.',vm:vm([],{contract:{...contract,goal:'Add JSON export with tests and docs',successCriteria:[{id:'sc_1',text:'Export selected rows as JSON'},{id:'sc_2',text:'Preserve existing CSV behavior'},{id:'sc_3',text:'Test and document JSON export'}]}})},
  tour:{title:'A short start, not an interview.',body:'The panel tracks setup and useful actions. Ask for the work as you normally would.',vm:vm([],{tourDismissed:false})},
  anatomy:{title:'One place to continue.',body:'Goal and boundaries. Current progress. Useful findings. Your controls.',vm:vm([round])}
 };
 const theme=`:root{--vscode-font-family:Arial,sans-serif;--vscode-font-size:13px;--vscode-foreground:#e5edf5;--vscode-descriptionForeground:#93a4b6;--vscode-textLink-foreground:#6ddbcc;--vscode-editor-background:#14222e;--vscode-button-secondaryBackground:#263949;--vscode-button-secondaryForeground:#eff9fb;--vscode-input-background:#101d28;--vscode-input-foreground:#f4f8fa;--vscode-input-border:#385266;--vscode-focusBorder:#49c8b5;--vscode-widget-border:#304655;--vscode-editorWarning-foreground:#f4c776}body{background:#14222e;zoom:1.15}`;
 const baseStyle=`*{box-sizing:border-box}body{margin:0;background:#0b1520;color:#edf5fa;font-family:Arial,sans-serif}.brand{display:flex;align-items:center;gap:14px;font-size:19px;font-weight:700}.brand img{width:45px;height:45px}.eyebrow{font-size:12px;letter-spacing:.18em;color:#77d9c9;text-transform:uppercase}.layout{display:grid;grid-template-columns:1fr 505px;gap:65px;padding:50px 70px 30px;height:810px}.copy{padding-top:55px}.copy h1{font-size:58px;line-height:1.06;letter-spacing:-.04em;margin:24px 0;color:#f3fafc}.copy p{font-size:23px;line-height:1.5;color:#aabfce;max-width:540px}.pillars{display:flex;gap:10px;margin:32px 0;flex-wrap:wrap}.pillars span{border:1px solid #2d525b;color:#a9e6dd;border-radius:30px;padding:10px 16px;font-size:14px}.panel-shell{border:1px solid #38505e;border-radius:14px;background:#14222e;overflow:hidden;box-shadow:0 20px 70px #0005}.panel-title{font-size:12px;color:#a6c0cf;padding:13px 18px;background:#1d303e;letter-spacing:.14em}.panel-shell iframe{width:100%;height:680px;border:0}.footer{position:absolute;left:70px;bottom:24px;color:#8ba4b7;font-size:12px}.cards{display:grid;gap:18px;max-width:540px;margin-top:32px}.card{padding:25px;border:1px solid #30515d;border-radius:12px;background:#142936}.card b{font-size:23px;color:#76dfcd}.card p{font-size:16px;margin:12px 0 0;line-height:1.45}.code{font:16px monospace;color:#b5e4dc}.sample{color:#f3cb7f;font-size:12px;letter-spacing:.13em}`;
 function panelDoc(model){const sections=renderSections(model);return `<!doctype html><html><head><style>${theme}\n${css}</style></head><body>${Object.entries(sections).map(([id,html])=>`<div id="${id}">${html}</div>`).join('')}<script>window.acquireVsCodeApi=()=>({postMessage(){}})</script><script>${js.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;}
 function frame(scene){return `<!doctype html><html><head><style>${baseStyle}</style></head><body><main class="layout"><section><div class="brand"><img src="${icon}">Cursor Goal Guardian</div><div class="copy"><div class="eyebrow">Goal loop · independent review · learning</div><h1>${esc(scene.title)}</h1><p>${esc(scene.body)}</p><div class="pillars"><span>Remember the goal</span><span>Finish what remains</span><span>Use corrections</span></div><div class="sample">PRODUCT ILLUSTRATION · EXAMPLE DATA</div></div></section><section class="panel-shell"><div class="panel-title">CURRENT CGG PANEL · EXAMPLE</div><iframe srcdoc="${esc(panelDoc(scene.vm))}"></iframe></section></main><footer class="footer">CGG ${manifest.version} · Current production panel, illustrated data · No real model run is shown</footer></body></html>`;}
 const exported=[];
 for(const [name,scene] of Object.entries(scenes)){await fs.writeFile(path.join(temp,name+'.html'),frame(scene));exported.push({name,fill:!!scene.fill});}
 const center=await fs.readFile(path.join(ext,'src/commandCenter.ts'),'utf8');
 const commandLabels=[...center.slice(center.indexOf('const items:'),center.indexOf('const picked')).matchAll(/label: "([^"]+)"/g)].map(x=>x[1].replace(/\$\([^)]*\)\s*/g,''));
 const skills=GUARDIAN_SKILLS.map(s=>({name:s.content.match(/^name: (.+)$/m)[1],description:s.content.match(/^description: (.+)$/m)[1]}));
 const setupText=await fs.readFile(path.join(ext,'src/setup.ts'),'utf8');
 const notice=setupText.slice(setupText.indexOf('export function offerMcpEnableGuidance')).match(/showInformationMessage\(\s*"([^"]+)"/)[1];
 const guides={
 slash:{title:'Ask. Brief. Steer.',cards:skills.map(s=>['/'+s.name,s.description]),body:'Chat skills installed by CGG. This is a menu illustration, not a Cursor screenshot.'},
 center:{title:'Your controls, together.',cards:commandLabels.map(s=>[s,'Available in Goal Guardian: Command Center.']),body:'Current action names, illustrated outside Cursor.'},
 briefing:{title:'Know what remains.',cards:[['/guardian','Goal: ship CSV export with filters and tests. The public export and its regression check still need finishing.'],['Continue the work','The agent reuses relevant work and checks instead of starting over.']],body:'Example briefing; real briefings come from the recorded goal and project.'},
 consent:{title:'Enable the connection.',cards:[['Cursor MCP settings',notice],['Open MCP Settings','Enable the goal-guardian server for this project.']],body:'Connection guidance from the current setup source. Illustrated notification, not a native screenshot.'}
 };
 for(const [name,g] of Object.entries(guides)){
  const html=`<!doctype html><html><head><style>${baseStyle}.layout{grid-template-columns:1fr 560px;align-items:center}.copy{padding-top:20px}.cards{margin-top:0}.card{padding:22px}.card b{font-size:20px}.card p{font-size:15px}</style></head><body><main class="layout"><section><div class="brand"><img src="${icon}">Cursor Goal Guardian</div><div class="copy"><div class="eyebrow">Current product guide</div><h1>${esc(g.title)}</h1><p>${esc(g.body)}</p><div class="sample">EXPLANATORY ILLUSTRATION</div></div></section><section class="cards">${g.cards.map(([a,b])=>`<div class="card"><b>${esc(a)}</b><p>${esc(b)}</p></div>`).join('')}</section></main><footer class="footer">CGG ${manifest.version} · Illustrative examples; no real model session is shown</footer></body></html>`;
  await fs.writeFile(path.join(temp,name+'.html'),html);exported.push({name});
 }
 const banner=`<!doctype html><html><head><style>${baseStyle}main{padding:54px 76px;display:flex;align-items:center;gap:52px;height:400px}main img{width:136px}h1{font-size:56px;letter-spacing:-.03em;margin:0 0 14px}.tag{font-size:29px;color:#a3e6da;margin:0 0 25px}.features{font-size:18px;color:#adc1d0}</style></head><body><main><img src="${icon}"><section><h1>Cursor Goal Guardian</h1><p class="tag">Keep Cursor working on your goal.</p><p class="features">Remember the goal &nbsp;·&nbsp; Review finished work &nbsp;·&nbsp; Learn from corrections</p></section></main></body></html>`;
 await fs.writeFile(path.join(temp,'banner.html'),banner);
 const config={root,ext,temp,scenes:exported,version:manifest.version};
 await fs.writeFile(path.join(temp,'config.json'),JSON.stringify(config));
 execFileSync(process.env.PYTHON??'python3',[path.join(root,'scripts/render-public-media.py'),path.join(temp,'config.json')],{stdio:'inherit'});
 const sources=['src/panel/render.ts','media/panel.css','src/commandCenter.ts','src/setup.ts'];
 const provenance={version:manifest.version,kind:'Labelled product illustrations, not model-run evidence',sources:Object.fromEntries(await Promise.all(sources.map(async f=>[f,createHash('sha256').update(await fs.readFile(path.join(ext,f))).digest('hex')])))};
 provenance.root_sources=Object.fromEntries(await Promise.all(['scripts/render-public-media.mjs','scripts/render-public-media.py','packages/core/src/viewmodel/panel.ts','packages/core/src/rule.ts'].map(async f=>[f,createHash('sha256').update(await fs.readFile(path.join(root,f))).digest('hex')])));
 await fs.writeFile(path.join(ext,'images/store/provenance.json'),JSON.stringify(provenance,null,2)+'\n');
} finally {await fs.rm(temp,{recursive:true,force:true});}
