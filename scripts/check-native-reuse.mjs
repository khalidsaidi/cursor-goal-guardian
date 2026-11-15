#!/usr/bin/env node
// Reuse an unchanged native build; its public API is tested again on the final host.
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
if(!job?.steps.some(step=>step.name==='Build the actual native goal runtime and hook/MCP programs' && step.conclusion==='success'))throw Error(`The earlier ${target} native build has not passed`);
if(!jobs.some(job=>job.steps.some(step=>step.name==='Test the real Codex goal wrapper' && step.conclusion==='success')))throw Error('The unchanged Rust source has no passing unit suite in that run');
run('git',['fetch','--no-tags','--depth','1','origin',previous.head_sha]);
const inputs=['packages/codex-goals/Cargo.toml','packages/codex-goals/Cargo.lock','packages/codex-goals/src','packages/codex-goals/build.rs','packages/codex-goals/.cargo','.cargo','rust-toolchain','rust-toolchain.toml'];
const diff=spawnSync('git',['diff','--quiet',previous.head_sha,'HEAD','--',...inputs]);
if(diff.status!==0)throw Error('Rust build inputs changed: build and test the native runtime instead of reusing it');
console.log(`Native Codex reuse checked: ${target}, run ${runId}, unchanged Rust inputs from ${previous.head_sha}`);
