"use client";
import { useEffect, useRef, useState } from "react";
import { Camera, Check, ChevronDown, LoaderCircle, Sparkles, Trash2, X } from "lucide-react";
import type { Extraction, Photo, Product, ProductFields, Project } from "@/lib/types";
import { emptyFields } from "@/lib/types";
import { writeDraft, type Draft } from "@/lib/draft";

type Props={project:Project; product?:Product; draft?:Draft; suppliers:string[]; modelEnabled:boolean; onClose:()=>void; onSaved:(supplier:string)=>void; onDeleted:()=>void; defaultSupplier:string};
type LocalPhoto={file:File;url:string};
const numericKeys=new Set(["weightG","unitPrice","moq","cartonQty"]);
function fieldsOf(product?:Product):ProductFields {
  if(!product) return {...emptyFields};
  return Object.fromEntries(Object.keys(emptyFields).map(k=>[k,product[k as keyof ProductFields]])) as ProductFields;
}
export function ProductEditor({project,product,draft,suppliers,modelEnabled,onClose,onSaved,onDeleted,defaultSupplier}:Props) {
  const [fields,setFields]=useState<ProductFields>(()=>draft?.fields || {...fieldsOf(product),supplier:product?.supplier || defaultSupplier});
  const [photos,setPhotos]=useState<Photo[]>(()=>draft?.photos || product?.photos || []);
  const [files,setFiles]=useState<LocalPhoto[]>(()=>draft?.files.map(f=>{const file=new File([f.blob],f.name,{type:f.type});return {file,url:URL.createObjectURL(file)};}) || []);
  const [busy,setBusy]=useState<"save"|"extract"|"delete"|null>(null);
  const [error,setError]=useState("");const [notice,setNotice]=useState("");
  const [draftStatus,setDraftStatus]=useState("草稿保存中…");const [expanded,setExpanded]=useState(Boolean(product || draft));
  const [deleteConfirm,setDeleteConfirm]=useState(false);
  const saved=useRef(false), current=useRef({fields,photos,files}), localPhotos=useRef(files), revision=useRef(0);
  const id=product?.id || draft?.productId;
  current.current={fields,photos,files};localPhotos.current=files;
  const buildDraft=():Draft=>({projectId:project.id,productId:id,fields:current.current.fields,photos:current.current.photos,files:current.current.files.map(p=>({name:p.file.name,type:p.file.type,blob:p.file})),savedAt:new Date().toISOString()});
  useEffect(()=>{
    const old=document.body.style.overflow;document.body.style.overflow="hidden";
    return ()=>{document.body.style.overflow=old;localPhotos.current.forEach(p=>URL.revokeObjectURL(p.url));};
  },[]);
  useEffect(()=>{
    if(saved.current) return;
    const timer=setTimeout(()=>{writeDraft(buildDraft()).then(()=>{if(!saved.current)setDraftStatus("草稿已保存在此设备");}).catch(()=>setDraftStatus("草稿未能保存，请保持页面打开"));},500);
    return ()=>clearTimeout(timer);
  },[fields,photos,files]);
  function update(key:keyof ProductFields,value:string|boolean) {
    revision.current++;
    const parsed=numericKeys.has(key) ? (value==="" ? null : Number(value)) : value;
    setFields(previous=>({...previous,[key]:parsed,...(key!=="confirmed"?{confirmed:false}:{})}));
  }
  function addPhotos(list:FileList|null) {
    if(!list) return;setError("");
    const selected=Array.from(list);
    if(photos.length+files.length+selected.length>6) {setError("每件商品最多6张照片");return;}
    if(selected.some(file=>file.size>8*1024*1024)) {setError("每张照片不能超过8MB");return;}
    revision.current++;setFields(previous=>({...previous,confirmed:false}));
    setFiles(previous=>[...previous,...selected.map(file=>({file,url:URL.createObjectURL(file)}))]);
  }
  async function close() {
    if(busy) return;
    try {await writeDraft(buildDraft());} catch {if(!window.confirm("草稿无法保存在设备上，关闭后可能丢失。仍然关闭？"))return;}
    onClose();
  }
  async function extract() {
    setBusy("extract");setError("");setNotice("");const startedAt=revision.current;
    try {
      const form=new FormData();form.set("description",fields.description);
      if(modelEnabled) {files.forEach(p=>form.append("photos",p.file));form.set("photoIds",JSON.stringify(photos.map(p=>p.id)));}
      const response=await fetch("/api/extract",{method:"POST",body:form});const data=await response.json();
      if(!response.ok) throw new Error(data.error || "整理失败");
      if(startedAt!==revision.current) {setNotice("输入已变更，请重新整理以避免覆盖最新内容。");return;}
      const result=data as Extraction;let conflict=false;
      const previous=current.current.fields, next={...previous,confirmed:false};
      for(const [key,value] of Object.entries(result.fields)) {
        const typedKey=key as keyof ProductFields;
        if(previous[typedKey]===""||previous[typedKey]===null||(key==="currency"&&previous.unitPrice===null)) Object.assign(next,{[key]:value});
        else if(previous[typedKey]!==value) conflict=true;
      }
      setFields(next);
      setExpanded(true);setNotice(result.warning+(conflict?" 已有字段保留，请检查可能的冲突。":""));
    } catch(error) {setError(error instanceof Error?error.message:"整理失败，输入已保留。");}
    finally {setBusy(null);}
  }
  async function submit(event:React.FormEvent) {
    event.preventDefault();setError("");setBusy("save");
    try {
      const form=new FormData();form.set("projectId",project.id);form.set("fields",JSON.stringify(fields));if(id)form.set("id",id);
      form.set("keepPhotoIds",JSON.stringify(photos.map(p=>p.id)));files.forEach(p=>form.append("photos",p.file));
      const response=await fetch("/api/products",{method:"POST",body:form});const result=await response.json();
      if(!response.ok) throw new Error(result.error || "保存失败");
      saved.current=true;await writeDraft(null).catch(()=>{});onSaved(fields.supplier);
    } catch(error) {setError(error instanceof Error?error.message:"保存失败，输入已保留。");}
    finally {setBusy(null);}
  }
  async function remove() {
    if(!id) return;setError("");setBusy("delete");
    try {const response=await fetch(`/api/products/${id}`,{method:"DELETE"});if(!response.ok)throw new Error((await response.json()).error);saved.current=true;await writeDraft(null).catch(()=>{});onDeleted();}
    catch(error){setError(error instanceof Error?error.message:"删除失败");}finally{setBusy(null);}
  }
  const input=(key:keyof ProductFields,label:string,placeholder="",numeric=false)=> <label className="field" key={key}><span>{label}</span><input name={key} value={fields[key]===null?"":String(fields[key])} onChange={event=>update(key,event.target.value)} type={numeric?"number":"text"} inputMode={numeric?"decimal":undefined} min={numeric?0:undefined} step={numeric?(key==="moq"||key==="cartonQty"?"1":"any"):undefined} maxLength={numeric?undefined:200} placeholder={placeholder} required={key==="name"}/></label>;
  return <div className="modal-backdrop" onClick={event=>{if(event.target===event.currentTarget)void close();}}>
    <section className="editor modal" role="dialog" aria-modal="true" aria-labelledby="editor-title">
      <header className="modal-heading"><div><p className="eyebrow">{project.name}</p><h2 id="editor-title">{id?"商品记录":"记录一件商品"}</h2></div><button type="button" className="icon-button" aria-label="关闭商品表单" onClick={()=>void close()} disabled={Boolean(busy)}><X size={22}/></button></header>
      <form onSubmit={submit}>
        <div className="editor-body">
          <label className="field"><span>供应商 / 摊位</span><input name="supplier" list="supplier-options" value={fields.supplier} onChange={e=>update("supplier",e.target.value)} placeholder="店铺名称、摊位号或联系人" maxLength={200}/><datalist id="supplier-options">{suppliers.map(s=><option key={s} value={s}/>)}</datalist></label>
          <div className="section-label"><strong>商品照片</strong><span>{photos.length+files.length}/6 · 每张最多 8MB</span></div>
          <div className="photo-grid">
            {photos.map(photo=><div className="photo-thumb" key={photo.id}><img src={photo.url} alt={photo.name}/><button type="button" aria-label={`移除照片 ${photo.name}`} onClick={()=>{revision.current++;setPhotos(previous=>previous.filter(p=>p.id!==photo.id));setFields(previous=>({...previous,confirmed:false}));}}><X size={14}/></button></div>)}
            {files.map((photo,index)=><div className="photo-thumb" key={photo.url}><img src={photo.url} alt={photo.file.name}/><button type="button" aria-label={`移除照片 ${photo.file.name}`} onClick={()=>{revision.current++;URL.revokeObjectURL(photo.url);setFiles(previous=>previous.filter((_,i)=>i!==index));setFields(previous=>({...previous,confirmed:false}));}}><X size={14}/></button></div>)}
            {photos.length+files.length<6&&<label className="photo-add"><Camera size={26}/><span>拍照 / 添加</span><input aria-label="添加商品照片" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple onChange={e=>{addPhotos(e.target.files);e.target.value="";}}/></label>}
          </div>
          <label className="field"><span>现场描述</span><textarea name="description" value={fields.description} onChange={e=>update("description",e.target.value)} rows={4} maxLength={10000} placeholder="用输入法语音输入：这款杯子红白两色，12元一个，100个起订，单个300克…"/></label>
          <div className="extract-panel"><div><strong>{modelEnabled?"图文整理":"文字整理"}</strong><small>{modelEnabled?"照片和描述将发送至智能整理服务":"使用明确文字填表 · 照片仅存档"}</small></div><button type="button" className="button secondary" onClick={()=>void extract()} disabled={Boolean(busy)||(!fields.description.trim()&&!modelEnabled)}>{busy==="extract"?<LoaderCircle className="spin" size={16}/>:<Sparkles size={16}/>}整理字段</button></div>
          {notice&&<p className="notice" role="status">{notice}</p>}
          <div className="fields-grid primary-fields">{input("name","商品名称 *","例如：陶瓷杯")}{input("colors","颜色","例如：红色、白色")}{input("unitPrice","单价","未记录",true)}<label className="field"><span>币种</span><select name="currency" value={fields.currency} onChange={e=>update("currency",e.target.value)}><option value="CNY">人民币 CNY</option><option value="USD">美元 USD</option><option value="EUR">欧元 EUR</option></select></label>{input("moq","起订量","未记录",true)}{input("weightG","单件重量（克）","未记录",true)}</div>
          <button type="button" className="expand-fields" onClick={()=>setExpanded(!expanded)}>更多商品信息<ChevronDown size={17} style={{transform:expanded?"rotate(180deg)":undefined}}/></button>
          {expanded&&<div className="fields-grid">{input("material","材质","未记录")}{input("dimensions","尺寸（含单位）","例如：35×40cm")}{input("cartonQty","每箱数量","未记录",true)}<label className="field"><span>备注</span><input name="notes" value={fields.notes} onChange={e=>update("notes",e.target.value)} maxLength={5000} placeholder="交期、包装或其他补充"/></label></div>}
          <label className="confirm-row"><input type="checkbox" checked={fields.confirmed} onChange={e=>update("confirmed",e.target.checked)}/><span><strong>我已核对这条记录</strong><small>未核对也可以保存，之后继续补充</small></span></label>
          {error&&<p role="alert" className="error-message">{error}</p>}
          {deleteConfirm&&<div className="delete-panel"><p>删除这件商品及其照片？此操作无法撤销。</p><div><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={()=>setDeleteConfirm(false)}>取消</button><button type="button" className="button danger" disabled={Boolean(busy)} onClick={()=>void remove()}>确认删除</button></div></div>}
        </div>
        <footer className="editor-footer"><div className="draft-status">{id?<button type="button" className="text-button danger-text" disabled={Boolean(busy)} onClick={()=>setDeleteConfirm(true)}><Trash2 size={15}/>删除商品</button>:<><span className="draft-dot"/>{draftStatus}</>}</div><button type="submit" className="button primary" disabled={Boolean(busy)}>{busy==="save"?<LoaderCircle size={17} className="spin"/>:<Check size={17}/>}保存记录</button></footer>
      </form>
    </section>
  </div>;
}
