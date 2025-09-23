// Front v4_1 (igual a v4 con /s/* en _redirects)
const MAX_BYTES = window.APP_CONFIG?.MAX_BYTES ?? (2 * 1024 * 1024 * 1024);
const $ = (s, root=document) => root.querySelector(s);
const prettyBytes = (b=0)=>{ if(!b) return "0 B"; const u=["B","KB","MB","GB","TB"]; const i=Math.floor(Math.log(b)/Math.log(1024)); const v=b/Math.pow(1024,i); return `${v.toFixed(i===0?0:v<10?2:1)} ${u[i]}`; };
$("#limit").textContent = prettyBytes(MAX_BYTES);
let lastPresigned = null;

const SETTINGS_KEY = "transfercloud_settings";
function loadSettings(){ try{ return JSON.parse(localStorage.getItem(SETTINGS_KEY)||"{}"); }catch{return {}} }
function saveSettings(obj){ localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj||{})); }
$("#inp-backend") && ($("#inp-backend").value = (loadSettings().backend || ""));
$("#inp-token") && ($("#inp-token").value = (loadSettings().token || ""));

const getBase = () => (loadSettings().backend || "").replace(/\/+$/,"");
const buildUrl = (p)=> (getBase()? getBase()+p : p);

async function pingHealth(){
  const dot=$("#health-dot"), label=$("#health-label");
  label.textContent="probando…"; dot.className="inline-block w-2.5 h-2.5 rounded-full bg-yellow-500";
  try{
    const r = await fetch(buildUrl("/salud"));
    await r.text();
    if (r.ok){ label.textContent="ok"; dot.className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500"; }
    else { label.textContent=`salud ${r.status}`; dot.className="inline-block w-2.5 h-2.5 rounded-full bg-red-500"; }
  }catch(e){ label.textContent="falló"; dot.className="inline-block w-2.5 h-2.5 rounded-full bg-red-500"; }
}
pingHealth();

const paneSend = $("#pane-send"); const paneCloud = $("#pane-cloud");
$("#tab-send").onclick = () => { paneSend.classList.remove("hidden"); paneCloud.classList.add("hidden"); };
$("#tab-cloud").onclick = () => { paneCloud.classList.remove("hidden"); paneSend.classList.add("hidden"); refreshCloud(); };

const modal = $("#modal"); const modalTitle=$("#modal-title"); const modalBody=$("#modal-body");
const corsTools = $("#cors-tools"); const presignHost = $("#presign-host");
const diag = $("#diag"); const corsJson = $("#cors-json");

const closeModal = ()=> modal.classList.add("hidden");
$("#modal-close").onclick = closeModal;
$("#btn-sub").onclick = () => { modalTitle.textContent="Suscripción $5/mes"; modalBody.innerHTML = "Incluye 100 GB, links sin límite, nube privada y soporte. (Demo)"; corsTools.classList.add("hidden"); modal.classList.remove("hidden"); };
$("#btn-buy").onclick = () => { modalTitle.textContent="Comprar GB"; modalBody.innerHTML = "Costo: $1 por GB. (Demo)"; corsTools.classList.add("hidden"); modal.classList.remove("hidden"); };

const settingsModal = $("#settings");
$("#btn-settings").onclick = ()=> settingsModal.classList.remove("hidden");
$("#btn-close-settings").onclick = ()=> settingsModal.classList.add("hidden");
$("#btn-save-settings").onclick = ()=> { saveSettings({ backend: $("#inp-backend").value.trim(), token: $("#inp-token").value.trim() }); settingsModal.classList.add("hidden"); pingHealth(); };

$("#btn-test-cors").onclick = async ()=>{
  diag.classList.remove("hidden"); diag.textContent = "Preparando prueba OPTIONS…";
  if (!lastPresigned?.url) { diag.textContent = "Aún no hay presigned URL. Haz un presign primero (intenta subir un archivo)."; return; }
  try {
    const u = new URL(lastPresigned.url);
    const res = await fetch(lastPresigned.url, {
      method: "OPTIONS",
      headers: {
        "Origin": location.origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type"
      }
    });
    diag.textContent = `OPTIONS ${u.host}\nstatus: ${res.status}\n` +
      `ACAO: ${res.headers.get("Access-Control-Allow-Origin")}\n` +
      `ACAH: ${res.headers.get("Access-Control-Allow-Headers")}\n` +
      `ACAM: ${res.headers.get("Access-Control-Allow-Methods")}\n` +
      `Vary: ${res.headers.get("Vary")}\n`;
  } catch (e) {
    diag.textContent = "Error OPTIONS: " + (e.message || String(e));
  }
};

$("#btn-copy-rule").onclick = async ()=>{
  if (!lastPresigned?.url) { corsJson.classList.remove("hidden"); corsJson.textContent = "Primero genera un presign para ver el host."; return; }
  const origin = location.origin;
  const json = [
    {
      AllowedOrigins: [origin],
      AllowedMethods: ["PUT","GET","HEAD"],
      AllowedHeaders: ["*"],
      ExposeHeaders: ["etag"],
      MaxAgeSeconds: 86400
    }
  ];
  const text = JSON.stringify(json, null, 2);
  corsJson.classList.remove("hidden");
  corsJson.textContent = text;
  try { await navigator.clipboard.writeText(text); $("#btn-copy-rule").textContent = "Regla copiada ✔"; setTimeout(()=> $("#btn-copy-rule").textContent="Copiar regla CORS para Cloudflare", 2000);} catch {}
};

const dropzone = $("#dropzone"); const fileInput = $("#file-input"); const queueDiv=$("#queue"); const linksDiv=$("#links"); const linksList=$("#links-list");
$("#btn-browse").onclick = ()=> fileInput.click();
fileInput.onchange = (e)=> handleFiles(e.target.files, "link");
dropzone.addEventListener("dragover",(e)=>{ e.preventDefault(); dropzone.classList.add("bg-white/5"); });
dropzone.addEventListener("dragleave",()=> dropzone.classList.remove("bg-white/5"));
dropzone.addEventListener("drop",(e)=>{ e.preventDefault(); dropzone.classList.remove("bg-white/5"); handleFiles(e.dataTransfer.files, "link"); });

function handleFiles(files, mode){ [...files].forEach(f=> startUpload({file:f, mode})); }

async function startUpload(item){
  const { file, mode } = item;
  if (file.size > MAX_BYTES){ addQueueRow(file, 0, "error", null, `Máximo ${prettyBytes(MAX_BYTES)} por archivo`); return; }
  const row = addQueueRow(file, 1, "signing");
  try {
    const headers = {"Content-Type":"application/json"};
    const token = (loadSettings().token || "").trim();
    if (token) headers["x-mixtli-token"] = token;

    const pres = await fetch(buildUrl("/api/presign"), { method: "POST", headers, body: JSON.stringify({ name:file.name, size:file.size, type:file.type || "application/octet-stream", mode: mode==="link"?"link":"cloud" }) });
    const text = await pres.text();
    let data = {}; try{ data = JSON.parse(text); }catch{}
    if(!pres.ok){ throw new Error((data && data.error) ? `Presign ${pres.status}: ${data.error}` : `Presign ${pres.status}: ${text.slice(0,140)}`); }
    if (!data.ok || !data.url) throw new Error("Presign inválido");
    lastPresigned = data;
    try { const u = new URL(data.url); presignHost.textContent = u.host; } catch {}

    modalTitle.textContent = "Herramientas CORS para tu bucket";
    modalBody.innerHTML = "Si el PUT falla, usa estas pruebas y copia la regla para Cloudflare R2:";
    $("#cors-tools").classList.remove("hidden"); modal.classList.remove("hidden");

    updateRow(row, 3, "uploading");
    await putWithProgressXHR(data.url, file, data.headers || {}, (p)=> updateRow(row, Math.max(3, Math.min(99, Math.floor(p))), "uploading"));
    const link = data.token ? `${location.origin}/s/${data.token}` : data.url;
    updateRow(row, 100, "done", link);
    addShareLink(file.name, link, data.expiresAt);
    if (mode !== "link") refreshCloud();
  } catch (e) {
    updateRow(row, 0, "error", null, e.message || String(e));
  }
}

function putWithProgressXHR(url, file, headers, onProg){
  return new Promise((resolve,reject)=>{
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    Object.entries(headers||{}).forEach(([k,v])=> xhr.setRequestHeader(k, v));
    if (!headers || !headers["Content-Type"]) xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e)=>{ if(e.lengthComputable){ onProg((e.loaded/e.total)*100); } };
    xhr.onload = ()=>{ (xhr.status>=200 && xhr.status<300) ? resolve(true) : reject(new Error("PUT "+xhr.status)); };
    xhr.onerror = ()=> reject(new Error("PUT error de red"));
    xhr.send(file);
  });
}

function addQueueRow(file, progress, status, link=null, err=null){
  const row = document.createElement("div");
  row.className = "card rounded-xl p-3";
  row.innerHTML = `
    <div class="flex items-center justify-between gap-4">
      <div class="min-w-0">
        <div class="truncate text-sm font-medium">${file.name}</div>
        <div class="text-xs opacity-70">${prettyBytes(file.size)} · <span class="row-status">${status}</span></div>
      </div>
      <div class="w-52 text-right"><span class="text-[11px] opacity-70 row-right">${progress}%</span></div>
    </div>
    <div class="mt-2 progress"><div class="bg-blue-500"></div></div>
    <div class="mt-2 text-xs text-red-300 row-error ${err?'':'hidden'}">${err||''}</div>
  `;
  $("#queue").prepend(row);
  updateRow(row, progress, status, link, err);
  return row;
}
function updateRow(row, progress, status, link=null, err=null){
  row.querySelector(".progress > div").style.width = `${progress}%`;
  row.querySelector(".row-status").textContent = status;
  const right = row.querySelector(".row-right");
  if (link){ right.innerHTML = `<a href="${link}" target="_blank" class="underline">Abrir link</a>`; } else { right.textContent = `${progress}%`; }
  const errEl = row.querySelector(".row-error");
  if (err){ errEl.textContent = err; errEl.classList.remove("hidden"); } else { errEl.classList.add("hidden"); }
}
function addShareLink(name, link, expiresAt){
  $("#links").classList.remove("hidden");
  const item = document.createElement("div");
  item.className = "card rounded-xl p-3 flex items-center justify-between gap-3";
  item.innerHTML = `
    <div class="min-w-0">
      <div class="truncate text-sm">${name}</div>
      <div class="text-xs opacity-70">${expiresAt ? ("Expira: " + new Date(expiresAt).toLocaleString()) : "Expiración automática"}</div>
    </div>
    <div class="flex items-center gap-2">
      <a href="${link}" target="_blank" class="text-xs underline">Abrir</a>
      <button class="text-xs px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 btn-copy">Copiar</button>
    </div>
  `;
  item.querySelector(".btn-copy").onclick = async ()=>{
    try { await navigator.clipboard.writeText(link); item.querySelector(".btn-copy").textContent="Copiado"; setTimeout(()=> item.querySelector(".btn-copy").textContent="Copiar", 1500);} catch{}
  };
  $("#links-list").prepend(item);
}

const usedEl = $("#used"); const cloudGrid=$("#cloud-grid"); const cloudStatus=$("#cloud-status"); const fileInputCloud=$("#file-input-cloud");
$("#btn-upload-cloud").onclick = ()=> fileInputCloud.click();
fileInputCloud.onchange = (e)=> [...e.target.files].forEach(f=> startUpload({file:f, mode:"cloud"}));
$("#btn-refresh").onclick = ()=> refreshCloud();

async function refreshCloud(){
  cloudStatus.classList.remove("hidden"); cloudStatus.textContent="Cargando tus archivos…";
  try {
    const r = await fetch(buildUrl("/api/list"), { headers: (loadSettings().token? {"x-mixtli-token": loadSettings().token} : {}) });
    const text = await r.text();
    let data = {}; try{ data = JSON.parse(text); }catch{}
    if(!r.ok) throw new Error((data&&data.error)? data.error : `List ${r.status}: ${text.slice(0,140)}`);
    const files = Array.isArray(data.files)? data.files : [];
    const total = files.reduce((a,b)=> a+(b.size||0), 0);
    usedEl.textContent = `(Usados: ${prettyBytes(total)})`;
    cloudGrid.innerHTML = "";
    files.forEach(f=>{
      const card = document.createElement("div");
      card.className = "card rounded-xl p-3";
      card.innerHTML = `
        <div class="text-sm font-medium truncate" title="${f.name}">${f.name}</div>
        <div class="text-xs opacity-70">${prettyBytes(f.size||0)}${f.contentType?(" · "+f.contentType):""}</div>
        ${f.url ? `<a href="${f.url}" target="_blank" class="mt-2 inline-block text-xs underline">Ver / Descargar</a>` : ""}
      `;
      cloudGrid.appendChild(card);
    });
    cloudStatus.classList.add("hidden");
  } catch(e){
    cloudStatus.textContent = e.message || String(e);
  }
}
