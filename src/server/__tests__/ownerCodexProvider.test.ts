import {expect,it,vi} from "vitest";
import {OwnerCodexProvider,type OwnerCodexExecute} from "../providers/ownerCodexProvider.js";
const env={FACTORY_OWNER_SUBSCRIPTION_ONLY:"1",FACTORY_OWNER_CODEX_HOME:process.cwd()+"/fixture-auth",FACTORY_OWNER_CODEX_MODEL:"gpt-6-astra",LOCALAPPDATA:process.cwd()};
const receipt={ok:true,complete:true,provider:"subscription:codex",billing_mode:"subscription",model:"gpt-6-astra",raw:"Fixture result",usage:{input_tokens:10,cached_input_tokens:0,output_tokens:4}};
it("enrollment preserves prompt and verified response metadata",async()=>{
 const run=vi.fn<OwnerCodexExecute>().mockResolvedValue(receipt);
 const provider=new OwnerCodexProvider(undefined,env,run);
 expect(await provider.generateText({system:"system",prompt:"Keep the API unchanged."})).toMatchObject({text:"Fixture result",provider:"openai",billingMode:"subscription",model:"gpt-6-astra"});
 expect(run.mock.calls[0][0]).toMatchObject({providers:["codex"],prompt:"Keep the API unchanged."});
 expect(run.mock.calls[0][1].env.OWNER_AI_CODEX_HOME).toBe(env.FACTORY_OWNER_CODEX_HOME);
});
it("unenrolled installation does not invoke the executor",async()=>{
 const run=vi.fn<OwnerCodexExecute>().mockResolvedValue(receipt);
 const provider=new OwnerCodexProvider(undefined,{...env,FACTORY_OWNER_SUBSCRIPTION_ONLY:"0"},run);
 await expect(provider.generateText({system:"",prompt:"request"})).rejects.toThrow(/not enrolled/);
 expect(run).not.toHaveBeenCalled();
});
it("different billing metadata does not satisfy the subscription contract",async()=>{
 const run=vi.fn<OwnerCodexExecute>().mockResolvedValue({...receipt,billing_mode:"paid_api"});
 await expect(new OwnerCodexProvider(undefined,env,run).generateText({system:"",prompt:"request"})).rejects.toThrow(/No completed/);
});

it("pre-cancelled generation does not invoke the executor",async()=>{
 const run=vi.fn<OwnerCodexExecute>().mockResolvedValue(receipt);
 await expect(new OwnerCodexProvider(AbortSignal.abort(),env,run).generateText({system:"",prompt:"request"})).rejects.toThrow();
 expect(run).not.toHaveBeenCalled();
});
