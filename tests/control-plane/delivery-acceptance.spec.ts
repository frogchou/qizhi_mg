import { describe,expect,it,vi } from 'vitest';
import { assessDelivery, type Criterion } from '../../apps/control-plane/src/tasks/delivery-acceptance';

const criteria:Criterion[]=[{id:'R1',requirement:'纽约实测气温',basis:'气温',priority:'required'}];
const nodes=[{nodeKey:'research',capability:'research.web',output:{output:{coverage:'complete',summary:'中央公园小雨'},evidence:[{source:'https://weather.gov/',excerpt:'light rain'}]}}];
describe('原始需求验收',()=>{
  it.each([
    ['missing',[],true],['met',['invented'],true],['met',[],true],['met',['E1'],false],
  ] as const)('checks the status %s against actual evidence %j',async(status,evidenceIds,review)=>{
    const run=vi.fn(async()=>({lastMessage:JSON.stringify({items:[{id:'R1',status,reason:'检查结果',evidenceIds}]})}));
    const result=await assessDelivery({run},'/unused','纽约气温','2026-11-13T01:30:00Z',nodes,criteria);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.assessment.review).toBe(review);
  });
  it('fails closed when a proposed criterion invents wording not present in the original goal',async()=>{
    const result=await assessDelivery({run:async()=>({lastMessage:JSON.stringify({items:[{requirement:'必须给出全天最低温',basis:'最低温',priority:'required'}]})})},'/unused','纽约天气','2026-11-13T01:30:00Z',nodes,[]);
    expect(result.assessment.review).toBe(true);
    expect(result.assessment).toHaveProperty('error');
  });
});
