const api=require('./api'),session=require('./session');
const PREFIX='huoji.organize.v1.';
function key(binding){session.assert(binding);return PREFIX+encodeURIComponent(binding.owner);}
function list(binding){const value=wx.getStorageSync(key(binding));return Array.isArray(value)?value.filter(x=>x&&typeof x.productId==='string').slice(-100):[];}
function write(binding,items){wx.setStorageSync(key(binding),items.slice(-100));}
function prepare(binding,product){const previous=list(binding).find(x=>x.productId===product.id),items=list(binding).filter(x=>x.productId!==product.id);items.push({productId:product.id,projectId:product.projectId,version:product.version,jobId:'',state:'submitting',recovered:previous&&previous.recovered||false,updatedAt:Date.now()});write(binding,items);}
function acknowledge(binding,productId,value){const items=list(binding),index=items.findIndex(x=>x.productId===productId);const item=Object.assign({},index<0?{productId}:items[index],value,{updatedAt:Date.now()});if(index<0)items.push(item);else items[index]=item;write(binding,items);}
async function submit(binding,product){
  prepare(binding,product);
  try{
    const result=await api.request('/api/products/'+encodeURIComponent(product.id)+'/organize',{method:'POST',identity:binding,data:{version:product.version}});
    session.assert(binding);acknowledge(binding,product.id,{jobId:result.jobId||'',state:result.state==='succeeded'?'succeeded':'running',version:result.product.version,error:''});return result;
  }catch(e){if(session.valid(binding))acknowledge(binding,product.id,{state:'failed',error:e.message});throw e;}
}
async function refresh(binding,products){
  const entries=list(binding), updated=new Map();
  for(const product of products.filter(p=>['queued','failed'].includes(p.organizeState)||entries.some(e=>e.productId===p.id&&['running','submitting'].includes(e.state)))){
    const entry=entries.find(e=>e.productId===product.id),jobId=product.organizeJobId||entry&&entry.jobId;
    if(entry && product.version>entry.version && product.organizeJobId!==entry.jobId){acknowledge(binding,product.id,{state:'succeeded',error:''});continue;}
    try{
      if(!jobId){if(entry&&Date.now()-entry.updatedAt>20000)acknowledge(binding,product.id,{state:'failed',error:'整理提交未确认，商品已保存，可重新整理'});continue;}
      const job=await api.getJob(jobId,binding);session.assert(binding);
      acknowledge(binding,product.id,{jobId,version:product.version,state:job.state,error:job.error&&job.error.message||''});
      if(['succeeded','failed'].includes(job.state)){
        const current=await api.request('/api/products/'+product.id,{identity:binding});session.assert(binding);
        const recovery=list(binding).find(x=>x.productId===product.id);
        if(job.state==='failed' && job.error && job.error.code==='MODEL_LOGIN_REQUIRED' && current.organizeJobId===jobId && current.organizeState!=='done' && !(recovery&&recovery.recovered)){
          acknowledge(binding,product.id,{recovered:true});
          await api.restoreModelSession(binding);session.assert(binding);
          const retried=await submit(binding,current);session.assert(binding);
          updated.set(product.id,Object.assign({},retried.product,{cover:product.cover,organizeLabel:'后台整理中',organizePending:true}));continue;
        }
        updated.set(product.id,Object.assign({},current,{cover:product.cover,organizeLabel:job.state==='failed'&&current.organizeJobId===jobId&&current.organizeState!=='done'?'整理未完成，点击查看':'',organizePending:false}));
      }
    }catch(e){if(!session.valid(binding))throw e;if(e.code==='NOT_FOUND')acknowledge(binding,product.id,{jobId,version:product.version,state:'failed',error:'整理任务未启动，商品已保存，可重新整理'});}
  }
  const latest=list(binding);
  return products.map(p=>{
    if(updated.has(p.id))return updated.get(p.id);
    const entry=latest.find(x=>x.productId===p.id),local=entry&&(p.organizeJobId?entry.jobId===p.organizeJobId:entry.version>=p.version);
    const state=p.organizeState==='done'?'done':local?entry.state:p.organizeState;
    return Object.assign({},p,{organizeLabel:state==='done'||state==='succeeded'?'':state==='failed'?'整理未完成，点击查看':state==='queued'||state==='pending'||state==='running'||state==='submitting'?'后台整理中':'',organizePending:['queued','pending','running','submitting'].includes(state)});
  });
}
module.exports={list,submit,refresh};
