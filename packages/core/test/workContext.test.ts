import {afterEach,describe,it,expect} from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {appendAudit,defaultContract,getGuardianPaths,goalHash,goalWorkContext,goalReviewFeedback,goalTurnContext,reviewEvidence,nowIso,REVIEW_POLICY,writeContract} from "../src/index.js";
import {verificationState} from "../src/goal/verificationState.js";
const made:string[]=[];
afterEach(async()=>{for(const p of made.splice(0))await fs.rm(p,{recursive:true,force:true});});
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"gg-work-"));made.push(root);
 const git=(...args:string[])=>execFileSync("git",args,{cwd:root,stdio:"ignore"});git("init","-q");
 await fs.writeFile(path.join(root,"a.js"),"export const a=1;\n");git("add",".");git("-c","user.name=t","-c","user.email=t@localhost","commit","-qm","base");
 const contract={...defaultContract(),goal:"Finish both exports",successCriteria:[{id:"a",text:"Export a"},{id:"b",text:"Export b"}]};
 await fs.mkdir(getGuardianPaths(root).telemetryDir,{recursive:true});await writeContract(root,contract);
 const hash=goalHash(contract);await appendAudit(root,{ts:nowIso(),kind:"goal.set",goalHash:hash});
 const tree=verificationState(root)!;
 await appendAudit(root,{ts:nowIso(),kind:"goal.review",id:"review1",goalHash:hash,reportTs:nowIso(),policy:REVIEW_POLICY,tree,ran:true,seconds:1,checks:[{id:"build",verdict:"holds",evidence:"local build completed"}],fails:[{id:"b",evidence:"No b export exists"}],extra:[{file:"a.js",what:"unnecessary formatting objection"}],verdicts:[{id:"a",verdict:"holds",evidence:"a imports correctly"},{id:"b",verdict:"fails",evidence:"b is missing"}]});
 return {root,contract,hash,tree};
}
describe("useful work carried into another chat",()=>{
 it("carries observed item results and actionable findings into goal context",async()=>{
  const {root}=await fixture();const work=await goalWorkContext(root);
  expect(work.last_review).toMatchObject({project_unchanged:true,items:[{id:"a",verdict:"holds"},{id:"b",verdict:"fails"}]});
  expect(work.next_steps.join(" ")).toContain("No b export exists");expect(work.verified_items).toEqual([]);
  const message=await goalTurnContext(root);
  expect(message).toContain("Previously checked item a: a imports correctly");
  expect(message).toContain("Recorded verification build (holds): local build completed");
  expect(message).toContain("No b export exists");
 });
 it("marks changed work stale and respects corrections to individual objections",async()=>{
  const {root}=await fixture();await fs.writeFile(path.join(root,"a.js"),"export const a=2;\n");
  await appendAudit(root,{ts:nowIso(),kind:"review.feedback",reviewId:"review1",index:1,label:"wrong"});
  const work=await goalWorkContext(root);expect(work.last_review?.project_unchanged).toBe(false);
  expect(work.last_review?.findings.join(" ")).toContain("No b export");expect(work.last_review?.findings.join(" ")).not.toContain("formatting objection");
  expect(work.last_review?.feedback_requires_recheck).toBe(true);
  const message=await goalTurnContext(root);
  expect(message).toContain("No b export exists");
  expect(message).not.toContain("unnecessary formatting objection");
  expect(message).toContain("Recorded before changes or feedback; check relevance before reusing");
 });
 it("turns incomplete verification into a concrete continuation step",async()=>{
  const {root,hash,tree}=await fixture();
  await appendAudit(root,{ts:nowIso(),kind:"goal.review",id:"incomplete",goalHash:hash,reportTs:nowIso(),policy:REVIEW_POLICY,tree,ran:true,seconds:1,fails:[],extra:[],unanswered:["public_api"]});
  expect(await goalTurnContext(root)).toContain("Finish the relevant check: No clear verdict for public_api");
 });
 it("uses the latest feedback without importing old or unjudged findings",async()=>{
  const {root,hash}=await fixture();
  await appendAudit(root,{ts:nowIso(),kind:"review.feedback",reviewId:"review1",index:0,label:"wrong"});
  let records=await import("../src/audit/log.js").then(m=>m.readGoalRecords(root));
  expect(goalReviewFeedback(records,hash)).toMatchObject([{judgment:"wrong",finding:expect.stringContaining("No b export")}]);
  await appendAudit(root,{ts:nowIso(),kind:"review.feedback",reviewId:"review1",index:0,label:"right"});
  records=await import("../src/audit/log.js").then(m=>m.readGoalRecords(root));
  expect(goalReviewFeedback(records,hash)).toMatchObject([{judgment:"right"}]);
  await appendAudit(root,{ts:nowIso(),kind:"goal.end",goalHash:hash,conversationId:"prior",outcome:"proved"});
  await appendAudit(root,{ts:nowIso(),kind:"goal.engine",event:{type:"goal/change",data:{operation:"create"}}});
  records=await import("../src/audit/log.js").then(m=>m.readGoalRecords(root));
  expect(goalReviewFeedback(records,hash)).toEqual([]);
 });
 it("retains review work when DeepSeek is first initialized for an existing goal",async()=>{
  const {root}=await fixture();
  await appendAudit(root,{ts:nowIso(),kind:"goal.engine",event:{type:"goal/change",data:{operation:"create"}}});
  expect((await goalWorkContext(root)).last_review?.id).toBe("review1");
 });
 it("does not mistake a temporary first-part stop for a different goal",async()=>{
  const {root,hash}=await fixture();
  await appendAudit(root,{ts:nowIso(),kind:"goal.end",goalHash:hash,conversationId:"c1",outcome:"set_aside"});
  await appendAudit(root,{ts:nowIso(),kind:"goal.engine",event:{type:"goal/change",data:{operation:"create"}}});
  expect((await goalWorkContext(root)).last_review?.id).toBe("review1");
 });
 it("keeps a recent correction when feedback exceeds the context bound",async()=>{
  const {root,hash,tree}=await fixture();
  await appendAudit(root,{ts:nowIso(),kind:"goal.review",id:"many",goalHash:hash,reportTs:nowIso(),policy:REVIEW_POLICY,tree,ran:true,seconds:1,fails:Array.from({length:9},(_,i)=>({id:`item${i}`,evidence:`problem${i}`})),extra:[]});
  for(let i=0;i<9;i++)await appendAudit(root,{ts:nowIso(),kind:"review.feedback",reviewId:"many",index:i,label:"wrong"});
  await appendAudit(root,{ts:nowIso(),kind:"review.feedback",reviewId:"many",index:0,label:"right"});
  const records=await import("../src/audit/log.js").then(m=>m.readGoalRecords(root));
  const feedback=goalReviewFeedback(records,hash);
  expect(feedback).toHaveLength(8);expect(feedback.at(-1)).toMatchObject({judgment:"right",finding:expect.stringContaining("problem0")});
 });
 it("supplies changed source beyond proof hints and discloses bounded evidence",async()=>{
  const {root}=await fixture();
  for(let i=0;i<10;i++)await fs.writeFile(path.join(root,`changed${i}.js`),`export const value${i}=${i};`);
  const steps=reviewEvidence(root,[],[]);
  const files=steps.filter(s=>s.tool_calls?.startsWith("guardian_project_file"));
  expect(files).toHaveLength(8);
  const coverage=JSON.parse(steps.at(-1)!.content);
  expect(coverage.changed_files).toBe(10);expect(coverage.omitted_changed_files).toHaveLength(2);
  expect(steps.some(s=>s.content.includes("export const value"))).toBe(true);
 });
 it("does not inherit old reviews or green receipts when the same words start a new goal",async()=>{
  const {root,hash,tree}=await fixture();
  await appendAudit(root,{ts:nowIso(),kind:"goal.end",conversationId:"old",goalHash:hash,outcome:"proved",tree,verifiedItems:["a","b"]});
  expect((await goalWorkContext(root)).verified_items).toEqual([]);
  await appendAudit(root,{ts:nowIso(),kind:"goal.review",id:"clean",goalHash:hash,reportTs:nowIso(),policy:REVIEW_POLICY,tree,ran:true,seconds:1,fails:[],extra:[]});
  await appendAudit(root,{ts:nowIso(),kind:"goal.end",conversationId:"old",goalHash:hash,outcome:"proved",tree,verifiedItems:["a","b"]});
  expect((await goalWorkContext(root)).verified_items).toEqual(["a","b"]);
  await appendAudit(root,{ts:nowIso(),kind:"goal.engine",event:{type:"goal/change",data:{operation:"create"}}});
  const work=await goalWorkContext(root);expect(work.last_review).toBeNull();expect(work.verified_items).toEqual([]);
 });
});
