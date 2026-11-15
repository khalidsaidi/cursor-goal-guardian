import {afterEach,describe,it,expect} from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {appendAudit,defaultContract,getGuardianPaths,goalHash,goalReviewFeedback,nowIso,readGoalRecords,recordChatReviewFeedback,recordUserPrompt,reviewFeedbackTargets,writeContract} from "../src/index.js";
const made:string[]=[];
afterEach(async()=>{for(const root of made.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"gg-chat-feedback-"));made.push(root);
 const contract={...defaultContract(),goal:"Add CSV export",successCriteria:[{id:"sc_1",text:"Export works"}]};
 await fs.mkdir(getGuardianPaths(root).telemetryDir,{recursive:true});await writeContract(root,contract);
 await recordUserPrompt(root,contract.goal,"c1","agent");
 const hash=goalHash(contract);
 await appendAudit(root,{ts:nowIso(),kind:"goal.set",goalHash:hash});
 await appendAudit(root,{ts:nowIso(),kind:"goal.review",id:"review1",goalHash:hash,reportTs:nowIso(),ran:true,seconds:1,fails:[{id:"sc_1",evidence:"requires an uppercase CSV filename"},{id:"behavior",evidence:"empty rows crash"}],extra:[]});
 return {root,hash};
}
describe("explicit feedback from normal chat",()=>{
 it("feeds the same current-review and learning records with the user's actual reason, without duplicate feedback",async()=>{
  const {root,hash}=await fixture();const words="The review's uppercase CSV filename complaint is wrong; lowercase names are allowed.";
  await recordUserPrompt(root,words,"c1","agent");
  const input={reviewId:"review1",index:0,label:"wrong" as const,userWords:words};
  expect(await recordChatReviewFeedback(root,input)).toMatchObject({accepted:true});
  expect(await recordChatReviewFeedback(root,input)).toMatchObject({accepted:true});
  const records=await readGoalRecords(root);
  expect(records.filter(r=>r.kind==="review.feedback")).toHaveLength(1);
  expect(reviewFeedbackTargets(records,"review1")).toMatchObject([{label:"wrong",userWords:words}]);
  expect(goalReviewFeedback(records,hash)).toMatchObject([{judgment:"wrong",userWords:words}]);
 });
 it("does not turn an agent opinion, old quote, or vague reply into a learning label",async()=>{
  const {root}=await fixture();const words="The review's uppercase CSV filename complaint is wrong.";
  await recordUserPrompt(root,words,"c1","agent");
  await recordUserPrompt(root,"Finish the remaining work.","c1","agent");
  expect(await recordChatReviewFeedback(root,{reviewId:"review1",index:0,label:"wrong",userWords:words})).toMatchObject({accepted:false});
  await recordUserPrompt(root,"That's wrong.","c1","agent");
  expect(await recordChatReviewFeedback(root,{reviewId:"review1",index:0,label:"wrong",userWords:"That's wrong."})).toMatchObject({accepted:false});
  await recordUserPrompt(root,"The review is not wrong about uppercase CSV filenames.","c1","agent");
  expect(await recordChatReviewFeedback(root,{reviewId:"review1",index:0,label:"wrong",userWords:"The review is not wrong about uppercase CSV filenames."})).toMatchObject({accepted:false});
  const repair="The uppercase CSV filename implementation is wrong; fix the code.";
  await recordUserPrompt(root,repair,"c1","agent");
  expect(await recordChatReviewFeedback(root,{reviewId:"review1",index:0,label:"wrong",userWords:repair})).toMatchObject({accepted:false});
  expect((await readGoalRecords(root)).some(r=>r.kind==="review.feedback")).toBe(false);
 });
 it("does not attach a chat judgment to another goal instance or a missing finding",async()=>{
  const {root,hash}=await fixture();const words="The review's uppercase CSV filename complaint is wrong.";
  await recordUserPrompt(root,words,"c1","agent");
  expect(await recordChatReviewFeedback(root,{reviewId:"review1",index:99,label:"wrong",userWords:words})).toMatchObject({accepted:false});
  await appendAudit(root,{ts:nowIso(),kind:"goal.end",goalHash:hash,conversationId:"prior",outcome:"proved"});
  await appendAudit(root,{ts:nowIso(),kind:"goal.engine",event:{type:"goal/change",data:{operation:"create"}}});
  expect(await recordChatReviewFeedback(root,{reviewId:"review1",index:0,label:"wrong",userWords:words})).toMatchObject({accepted:false});
 });
 it("can confirm a specific useful catch",async()=>{
  const {root}=await fixture();const words="The review is correct about empty rows; that is a real bug.";
  await recordUserPrompt(root,words,"c1","agent");
  expect(await recordChatReviewFeedback(root,{reviewId:"review1",index:1,label:"right",userWords:words})).toMatchObject({accepted:true});
  expect(reviewFeedbackTargets(await readGoalRecords(root),"review1")).toMatchObject([{key:"finding_1",label:"right",userWords:words}]);
 });
});
