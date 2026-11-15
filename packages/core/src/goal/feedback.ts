/** Explicit chat feedback joins the same current-review and RRSI records as panel feedback. */
import {readGoalRecords} from "../audit/log.js";
import {readContractSafe} from "../safeReaders.js";
import {readUserPrompts} from "./record.js";
import {userSaidLatest} from "./evaluate.js";
import {goalHash,resumeMissedGoal} from "./loop.js";
import {currentGoalRecords} from "./workContext.js";
import {objectionEntries} from "./review.js";
import {recordReviewFeedback} from "./improve.js";

export async function recordChatReviewFeedback(root:string,input:{reviewId:string;index:number;label:"right"|"wrong"|"missed";userWords:string}) {
  const no=(reason:string)=>({accepted:false,resumed:false,message:`Feedback not saved: ${reason}. Continue the user's actual request; do not ask for a verdict just to fill this record.`});
  const prompts=await readUserPrompts(root);
  if(!prompts?.length || !userSaidLatest(input.userWords,prompts))return no("quote the user's latest recorded message");
  const contract=await readContractSafe(root);
  const records=currentGoalRecords(await readGoalRecords(root),goalHash(contract));
  const review=[...records].reverse().find(r=>r.kind==="goal.review" && r.goalHash===goalHash(contract));
  if(review?.kind!=="goal.review" || review.id!==input.reviewId || !review.ran)return no("use the latest review of this goal");
  const entries=objectionEntries(review);
  const words=input.userWords.toLowerCase().replace(/[‘’]/g,"'");
  if(input.label==="missed") {
    if(entries.length || !/\b(not done|wasn't done|was not done|isn't done|is not done|unfinished|still missing|missed)\b/.test(words))return no("this is not an explicit rejection of a passed review");
  } else {
    const entry=entries.find(e=>e.index===input.index);
    if(!entry)return no("that finding is not on the current review");
    if(!/\b(review|reviewer|evaluation|finding|complaint|objection|false alarm|good catch)\b/.test(words))return no("the message does not explicitly judge the review");
    const judgment=input.label==="wrong" ? /\b(wrong|incorrect|false alarm|unnecessary|not needed|not a (?:bug|problem|defect)|not extra|isn't extra|shouldn't flag|should not flag)\b/ : /\b(right|correct|valid|good catch|real (?:bug|problem|defect))\b/;
    const negated=input.label==="wrong" ? /\b(?:not|isn't|wasn't|aren't) (?:wrong|incorrect|unnecessary)\b/ : /\b(?:not|isn't|wasn't|aren't) (?:right|correct|valid)\b/;
    if(!judgment.test(words) || negated.test(words))return no("the message does not explicitly judge that finding");
    const terms=entry.line.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g)??[];
    const generic=new Set(["review","reviewer","evaluator","finding","complaint","objection","done","this","that","with","from","have","does","should","would","could","evidence","requirement","wrong","incorrect","right","correct","valid","requires","required","problem","defect","missing","still","about","there"]);
    const named=terms.some(t=>{
      const stem=t.replace(/s$/,"");
      return !generic.has(t) && words.includes(stem) && entries.every(other=>other.index===entry.index || !other.line.toLowerCase().includes(stem));
    });
    const sole=entries.length===1 && /\b(review|reviewer|finding|complaint|objection|good catch)\b/.test(words);
    if(!named && !sole)return no("the message does not identify which finding it judges");
  }
  const prior=[...records].reverse().find(r=>r.kind==="review.feedback" && r.reviewId===input.reviewId && r.index===(input.label==="missed"?0:input.index));
  if(prior?.kind!=="review.feedback" || prior.label!==input.label || prior.userWords!==input.userWords)await recordReviewFeedback(root,input.reviewId,input.label==="missed"?0:input.index,input.label,{userWords:input.userWords,source:"chat"});
  const resumed=input.label==="missed"?await resumeMissedGoal(root,input.reviewId):false;
  return {accepted:true,resumed,message:resumed?"Feedback saved and the original goal reopened. Continue the unfinished work.":"Feedback saved for the current check and future eligible learning. Continue the user's request."};
}
