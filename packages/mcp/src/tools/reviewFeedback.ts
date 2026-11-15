import {z} from "zod";
import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {recordChatReviewFeedback} from "@goal-guardian/core";
import {workspaceRoot} from "../workspace.js";

export function registerReviewFeedback(server:McpServer):void {
  server.registerTool("guardian_review_feedback",{
    description:"Save the user's explicit chat judgment on the latest CGG review: right for a useful finding, wrong for a rejected complaint, or missed when the user says work a clean review accepted was not done. Use get_goal.work.last_review.id and feedback_targets indexes; quote their latest recorded message exactly in user_words. Never label your own agreement/disagreement, an agent repair, a vague remark or an ordinary request as user feedback. Do not ask the user to rate findings. This feeds the current check and the existing bounded RRSI learner; it does not change requirements or automatically approve work. A missed acceptance can reopen the original goal; continue it in this chat.",
    inputSchema:{review_id:z.string(),finding_index:z.number().int().nonnegative().default(0),judgment:z.enum(["right","wrong","missed"]),user_words:z.string().min(1)}
  },async({review_id,finding_index,judgment,user_words})=>{
    const result=await recordChatReviewFeedback(await workspaceRoot(),{reviewId:review_id,index:finding_index,label:judgment,userWords:user_words});
    return {...(result.accepted?{}:{isError:true}),content:[{type:"text" as const,text:JSON.stringify(result)}]};
  });
}
