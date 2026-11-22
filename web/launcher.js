// re3 WebAssembly runtime launcher.
(() => {
	"use strict";
	const els = {
		statusDot:document.getElementById("status-dot"), statusText:document.getElementById("status-text"),
		loadingOverlay:document.getElementById("loading-overlay"), loadingStatus:document.getElementById("loading-status"), progressFill:document.getElementById("progress-fill"),
		errorBanner:document.getElementById("error-banner"), errorDetail:document.getElementById("error-detail"), errorCloseBtn:document.getElementById("error-close-btn"),
		canvas:document.getElementById("canvas"), viewport:document.getElementById("viewport"), sidepanel:document.getElementById("sidepanel"),
		diagnosticsBtn:document.getElementById("diagnostics-btn"), inputDebugBtn:document.getElementById("input-debug-btn"), sidepanelCloseBtn:document.getElementById("sidepanel-close-btn"),
		fullscreenBtn:document.getElementById("fullscreen-btn"), diagnosticsTable:document.getElementById("diagnostics-table"), logOutput:document.getElementById("log-output"),
		assetsOverlay:document.getElementById("assets-overlay"), assetsStatus:document.getElementById("assets-status"), assetsMissingList:document.getElementById("assets-missing-list"),
		pickFolderBtn:document.getElementById("pick-folder-btn"), devMountBtn:document.getElementById("dev-mount-btn"), startEngineBtn:document.getElementById("start-engine-btn"), folderInput:document.getElementById("folder-input"),
		pointerlockHint:document.getElementById("pointerlock-hint"), inputSummaryTable:document.getElementById("input-summary-table"), inputMouseTable:document.getElementById("input-mouse-table"), inputKeysList:document.getElementById("input-keys-list"), inputGamepadInfo:document.getElementById("input-gamepad-info"),
		perfTable:document.getElementById("perf-table"), fpsBadge:document.getElementById("fps-badge"), bootProgressList:document.getElementById("boot-progress-list"), debugModeCheckbox:document.getElementById("debug-mode-checkbox"),
		saveTable:document.getElementById("save-table"), saveForceSyncBtn:document.getElementById("save-force-sync-btn"), saveClearBtn:document.getElementById("save-clear-btn")
	};

	function setStatus(state,text){ els.statusDot.dataset.state=state; els.statusText.textContent=text; }
	function setLoadingStatus(text){ els.loadingStatus.textContent=text; }
	function setProgress(fraction){ if(fraction==null){els.progressFill.classList.add("indeterminate");els.progressFill.style.width="";}else{els.progressFill.classList.remove("indeterminate");els.progressFill.style.width=`${Math.round(Math.max(0,Math.min(1,fraction))*100)}%`;}}
	function hideLoadingOverlay(){ els.loadingOverlay.classList.add("hidden"); }

	const MAX_LOG_LINES=500; let logLineCount=0;
	function log(text,cls){ const line=document.createElement("div"); line.className="log-line"+(cls?` ${cls}`:""); line.textContent=text; els.logOutput.appendChild(line); logLineCount++; if(logLineCount>MAX_LOG_LINES){els.logOutput.removeChild(els.logOutput.firstChild);logLineCount--;} els.logOutput.scrollTop=els.logOutput.scrollHeight; }
	function formatError(err){ if(err==null)return "(no error object)"; if(err instanceof Error)return err.stack||`${err.name}: ${err.message}`; if(typeof err=== "object"){try{return JSON.stringify(err,null,2);}catch{}} return String(err); }
	function hideFatalError(){ els.errorBanner.classList.remove("visible"); els.errorBanner.setAttribute("aria-hidden","true"); }
	function showFatalError(title,err){ const detail=formatError(err); els.errorDetail.textContent=detail.length>4000?detail.slice(0,4000)+"\n…(truncated)":detail; els.errorBanner.querySelector(".error-title").textContent=title; els.errorBanner.classList.add("visible"); els.errorBanner.setAttribute("aria-hidden","false"); hideLoadingOverlay(); setStatus("error",title); log(`[fatal] ${title}: ${detail}`,"stderr"); console.error(title,err); }
	els.errorCloseBtn?.addEventListener("click",hideFatalError);

	function setSidePanel(open,section){
		els.sidepanel.classList.toggle("open",open);
		els.sidepanel.setAttribute("aria-hidden",open?"false":"true");
		els.diagnosticsBtn.setAttribute("aria-expanded",open&&section!=="input"?"true":"false");
		els.inputDebugBtn.setAttribute("aria-expanded",open&&section==="input"?"true":"false");
		if(open){ requestAnimationFrame(()=>{ const target=document.getElementById(section==="input"?"input-debug-section":"diagnostics-section")||document.getElementById("diagnostics-section"); target?.scrollIntoView({block:"start"}); }); }
	}
	els.diagnosticsBtn.addEventListener("click",()=>setSidePanel(!els.sidepanel.classList.contains("open")||els.inputDebugBtn.getAttribute("aria-expanded")=== "true","diagnostics"));
	els.inputDebugBtn.addEventListener("click",()=>setSidePanel(!els.sidepanel.classList.contains("open")||els.diagnosticsBtn.getAttribute("aria-expanded")=== "true","input"));
	els.sidepanelCloseBtn?.addEventListener("click",()=>setSidePanel(false));
	document.addEventListener("keydown",(event)=>{ if(event.key=== "Escape" && els.sidepanel.classList.contains("open")) setSidePanel(false); });

	const diagRows=new Map();
	function setDiag(key,value,ok){ let row=diagRows.get(key); if(!row){row=document.createElement("tr"); const k=document.createElement("td"); k.className="key"; k.textContent=key; const v=document.createElement("td"); v.className="val"; row.append(k,v); els.diagnosticsTable.appendChild(row);diagRows.set(key,row);} const val=row.children[1]; val.textContent=value; if(ok===undefined)delete val.dataset.ok;else val.dataset.ok=String(ok); }
	function updateCanvasDiagnostics(){ const rect=els.canvas.getBoundingClientRect(); setDiag("Canvas CSS size",`${Math.round(rect.width)} x ${Math.round(rect.height)}`); setDiag("Canvas backing size",`${els.canvas.width} x ${els.canvas.height}`); setDiag("window.innerWidth x innerHeight",`${window.innerWidth} x ${window.innerHeight}`); setDiag("document.hidden",String(document.hidden)); setDiag("document.visibilityState",document.visibilityState); }
	function collectStaticDiagnostics(){ setDiag("WASM loaded","false",false); setDiag("Engine initialized","false",false); let gl=document.createElement("canvas").getContext("webgl2")||document.createElement("canvas").getContext("webgl"); setDiag("WebGL available",String(!!gl),!!gl); setDiag("WebAssembly support",String(typeof WebAssembly=== "object"),typeof WebAssembly=== "object"); setDiag("SharedArrayBuffer",String(typeof SharedArrayBuffer!== "undefined")); setDiag("crossOriginIsolated",String(!!window.crossOriginIsolated)); setDiag("hardwareConcurrency",String(navigator.hardwareConcurrency??"unknown")); setDiag("Fullscreen API",String(!!document.documentElement.requestFullscreen),!!document.documentElement.requestFullscreen); setDiag("Pointer Lock API",String(!!els.canvas.requestPointerLock),!!els.canvas.requestPointerLock); setDiag("devicePixelRatio",String(window.devicePixelRatio||1)); setDiag("userAgent",navigator.userAgent); setDiag("location",location.href); updateCanvasDiagnostics(); }

	function resizeCanvasToDisplaySize(){ const dpr=window.devicePixelRatio||1; const rect=els.viewport.getBoundingClientRect(); const width=Math.max(1,Math.round(rect.width*dpr)); const height=Math.max(1,Math.round(rect.height*dpr)); if(els.canvas.width!==width||els.canvas.height!==height){els.canvas.width=width;els.canvas.height=height;} updateCanvasDiagnostics(); }
	function setupResizeHandling(){ resizeCanvasToDisplaySize(); if(typeof ResizeObserver!== "undefined")new ResizeObserver(resizeCanvasToDisplaySize).observe(els.viewport); window.addEventListener("resize",resizeCanvasToDisplaySize); document.addEventListener("visibilitychange",()=>{if(!document.hidden)resizeCanvasToDisplaySize();}); }
	function setupFullscreen(){ els.fullscreenBtn.addEventListener("click",()=>{if(!document.fullscreenElement)els.viewport.requestFullscreen?.().catch(err=>log(`[fullscreen] request failed: ${err}`,"stderr"));else document.exitFullscreen?.();}); document.addEventListener("fullscreenchange",()=>{els.fullscreenBtn.textContent=document.fullscreenElement?"Exit fullscreen":"Fullscreen";requestAnimationFrame(resizeCanvasToDisplaySize);}); }

	function setupSaveDiagnosticsPanel(){ const rows=new Map(); function setRow(key,value){let row=rows.get(key);if(!row){row=document.createElement("tr");const k=document.createElement("td");k.className="key";k.textContent=key;const v=document.createElement("td");v.className="val";row.append(k,v);els.saveTable.appendChild(row);rows.set(key,row);}row.children[1].textContent=value;} function render(){const s=Re3Saves.getStatus();setRow("Backend",s.backend);setRow("Save directory",s.saveDir||"(not mounted yet)");setRow("Storage status",s.state=== "syncing"?"Syncing…":"Ready");setRow("Last sync",s.lastSyncResult?`${s.lastSyncResult=== "success"?"Success":"Failure: "+s.lastSyncError}${s.lastSyncAt?` @ ${s.lastSyncAt.toLocaleTimeString()}`:""}`:"(none yet)");} Re3Saves.setOnStateChange(render);render(); els.saveForceSyncBtn.addEventListener("click",()=>{log("[Save] Force Save Sync requested","info");Re3Saves.forceSync();}); els.saveClearBtn.addEventListener("click",async()=>{if(!confirm("Delete all browser-saved GTA III save games? This cannot be undone."))return;try{await Re3Saves.clearSaves();render();}catch(err){log(`[Save] ERROR: could not clear saves: ${err}`,"stderr");}}); }

	async function main(){ collectStaticDiagnostics(); setupResizeHandling(); setupFullscreen(); Re3Boot.setupWebGLErrorCapture(els.canvas,log); Re3Input.setupPreventDefaults(); Re3Input.setupPointerLock(els.canvas,els.pointerlockHint,log); Re3Input.setupDebugOverlay({summaryTable:els.inputSummaryTable,mouseTable:els.inputMouseTable,keysList:els.inputKeysList,gamepadInfo:els.inputGamepadInfo}); if(typeof createRe3Module!== "function"){showFatalError("build/re3_wasm.js did not load",new Error("createRe3Module() is not defined."));return;} let instance; try{instance=await createRe3Module({canvas:els.canvas,print:text=>log(text,"stdout"),printErr:text=>log(text,"stderr"),setStatus:text=>{if(text)setLoadingStatus(text);},onAbort:reason=>showFatalError("WebAssembly runtime aborted",reason)});}catch(err){showFatalError("Failed to instantiate the WebAssembly module",err);return;} window.re3Module=instance; setDiag("WASM loaded","true",true); hideLoadingOverlay(); setupSaveDiagnosticsPanel(); }
	window.addEventListener("error",event=>{if(els.errorBanner.classList.contains("visible"))return;showFatalError("Unhandled script error",event.error||event.message);}); window.addEventListener("unhandledrejection",event=>{if(els.errorBanner.classList.contains("visible"))return;showFatalError("Unhandled promise rejection",event.reason);}); main().catch(err=>showFatalError("Launcher failed unexpectedly",err));
})();
