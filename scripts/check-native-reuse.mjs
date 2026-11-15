#!/usr/bin/env node
// Reuse a platform's tested Codex executable only when its Rust inputs are unchanged.
import {spawnSync} from 'node:child_process';
const [runId,target]=process.argv.slice(2);
if(!/^\d+$/.test(runId??'') || !/^(linux|darwin|win32)-(x64|arm64)$/.test(target??'')) throw Error('Pass the earlier run ID and platform target');
const repo=process.env.GITHUB_REPOSITORY;
if(!repo)throw Error('GITHUB_REPOSITORY is required');
const run=(command,args)=>{
 const result=spawnSync(command,args,{encoding:'utf8'});
 if(result.status!==0)throw Error(`${command} failed: ${result.stderr??result.error}`);
 return result.stdout;
};
const previous=JSON.parse(run('gh',['api',`repos/${repo}/actions/runs/${runId}`]));
const jobs=JSON.parse(run('gh',['api',`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`])).jobs;
const job=jobs.find(job=>job.name===`Complete package (${target})`);
if(!job?.steps.some(step=>step.name==='Test the real Codex goal wrapper' && step.conclusion==='success'))throw Error(`The earlier ${target} native Rust tests have not passed`);
run('git',['fetch','--no-tags','--depth','1','origin',previous.head_sha]);
const inputs=['packages/codex-goals/Cargo.toml','packages/codex-goals/Cargo.lock','packages/codex-goals/src','packages/codex-goals/build.rs','packages/codex-goals/.cargo','.cargo','rust-toolchain','rust-toolchain.toml'];
const diff=spawnSync('git',['diff','--quiet',previous.head_sha,'HEAD','--',...inputs]);
if(diff.status!==0)throw Error('Rust build inputs changed: build and test the native runtime instead of reusing it');
console.log(`Native Codex reuse checked: ${target}, run ${runId}, unchanged Rust inputs from ${previous.head_sha}`);
