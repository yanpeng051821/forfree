import type { Photo, ProductFields } from "./types";
export type Draft = { projectId:string; productId?:string; fields:ProductFields; photos:Photo[]; files:{name:string;type:string;blob:Blob}[]; savedAt:string };
function openDB():Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open("huoji-drafts",1);
    request.onupgradeneeded=()=>request.result.createObjectStore("drafts");
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error("请关闭其他页面后重试"));
  });
}
export async function readDraft():Promise<Draft|null> {
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("drafts","readonly"), request=tx.objectStore("drafts").get("current");
    request.onsuccess=()=>resolve(request.result || null);request.onerror=()=>reject(request.error);tx.oncomplete=()=>db.close();
  });
}
export async function writeDraft(draft:Draft|null) {
  const db=await openDB();
  return new Promise<void>((resolve,reject)=>{
    const tx=db.transaction("drafts","readwrite"), store=tx.objectStore("drafts");
    if(draft) store.put(draft,"current");else store.delete("current");
    tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};tx.onabort=()=>{db.close();reject(tx.error);};
  });
}
