// Persistent save storage for re3 (browser build). See docs/SAVES_WASM.md.
//
// re3's own save system (src/save/PCSave.cpp, src/save/GenericGameStorage.cpp)
// is completely unmodified in *what* it does: it still opens/reads/writes
// plain files with CFileMgr, under a directory it computes itself
// (_psGetUserFilesFolder() -> "userfiles", src/skel/glfw/glfw.cpp). This file
// only makes that one directory persist across page reloads, reusing the
// exact same IDBFS/IndexedDB mechanism web/vfs.js already uses for game
// assets -- but as its OWN, separate IDBFS mount, so a save (tens of KB)
// never needs to sync the entire multi-hundred-MB asset tree, and vice versa.
//
// Two entry points:
//   - mountAndRestore(instance, assetMountPoint, logFn): called once from
//     web/launcher.js's runEngineMain(), BEFORE re3's own callMain() runs.
//     Mounts IDBFS at <assetMountPoint>/userfiles and restores whatever was
//     persisted last time (FS.syncfs(true)) -- awaited, so re3's own startup
//     save-slot scan (C_PcSave::PopulateSlotInfo(), called from the frontend
//     menu once the engine is running) never sees a directory the browser
//     hasn't finished restoring into yet.
//   - window.Re3Saves.onSaveDirChanged(reason): called directly from C++
//     (src/save/PCSave.cpp's re3_NotifySaveDirChangedJS, right after
//     SaveSlot()/DeleteSlot() finish touching a file) to queue a persist
//     (FS.syncfs(false)) back to IndexedDB.

(() => {
	"use strict";

	const SAVE_SUBDIR = "userfiles";

	let FS = null;
	let saveDir = null;
	let saveMount = null; // the IDBFS mount descriptor for saveDir specifically (FS.mount()'s return value's .mount)
	let logFn = () => {};

	// --- sync state machine ---------------------------------------------------
	// IDLE -> (change) -> SYNCING -> (another change arrived while syncing?)
	//   no  -> IDLE
	//   yes -> sync again, then re-evaluate
	// This guarantees FS.syncfs(false) calls never overlap, and that the
	// *last* change made before the sync queue drains is always the one that
	// ends up persisted -- never silently dropped.
	const IDLE = "idle";
	const SYNCING = "syncing";
	let state = IDLE;
	let pending = false;
	let syncPromise = null;
	let lastSyncResult = null; // "success" | "failure" | null (never synced yet)
	let lastSyncError = null;
	let lastSyncAt = null;
	let onStateChange = () => {};

	function setState(next) {
		state = next;
		try { onStateChange(); } catch { /* diagnostics-panel errors must not break saving */ }
	}

	// Deliberately NOT the top-level FS.syncfs(): that call walks *every* mounted
	// filesystem from root (FS.getMounts(FS.root.mount)), and saveDir is mounted
	// *inside* the asset root (assetMountPoint/userfiles is a child of the /game
	// IDBFS mount, per the game's own relative-path expectations -- see
	// mountAndRestore() below). Emscripten's IDBFS.getLocalSet() walks its whole
	// subtree including nested mount points, so a global FS.syncfs() call ends up
	// asking the *asset* mount to reconcile a child directory that is actually a
	// different IDBFS mount underneath it -- and when that diff says "this local
	// entry isn't in my remote set, remove it", it calls FS.rmdir() on a live
	// mountpoint, which throws (ErrnoError errno 10). Calling the save mount's own
	// `type.syncfs` directly scopes the operation to exactly this one mount, so it
	// can never touch (or be touched by) the asset tree's own reconciliation.
	function syncfsAsync(populate) {
		return new Promise((resolve, reject) => {
			saveMount.type.syncfs(saveMount, populate, (err) => (err ? reject(err) : resolve()));
		});
	}

	async function runSync() {
		setState(SYNCING);
		try {
			await syncfsAsync(false);
			lastSyncResult = "success";
			lastSyncError = null;
			logFn("[Save] Sync complete", "info");
		} catch (err) {
			lastSyncResult = "failure";
			lastSyncError = String((err && err.message) || err);
			logFn(`[Save] ERROR: IndexedDB sync failed: ${lastSyncError}`, "stderr");
		}
		lastSyncAt = new Date();
		if (pending) {
			pending = false;
			await runSync(); // a newer change arrived mid-sync -- run once more
			return;
		}
		setState(IDLE);
	}

	function requestSync() {
		if (!FS || !saveDir) return Promise.reject(new Error("save directory is not available"));
		if (!saveMount) return Promise.reject(new Error("persistent save storage is unavailable in this session"));
		if (state === SYNCING) {
			pending = true; // coalesce -- never start a second overlapping syncfs()
			return syncPromise;
		}
		syncPromise = runSync().finally(() => { syncPromise = null; });
		return syncPromise;
	}

	/** Called directly from C++ (src/save/PCSave.cpp) right after a save/delete. */
	function onSaveDirChanged(reason, filename) {
		logFn(reason === "delete" ? `[Save] Save deleted: ${filename}` : `[Save] Save written: ${filename}`, "info");
		if (saveMount) {
			logFn("[Save] Syncing to IndexedDB…", "info");
			requestSync().catch(() => {});
		} else {
			logFn("[Save] Save is available for this session only (IDBFS is unavailable)", "info");
		}
	}

	/**
	 * Mount a dedicated IDBFS at <assetMountPoint>/userfiles and restore
	 * whatever was persisted last session. Must be awaited by the caller --
	 * FS.syncfs() is asynchronous, and re3's startup save-slot scan must never
	 * run before this resolves. On any failure (IDBFS unavailable, e.g. some
	 * private-browsing modes), falls back to a plain in-memory directory: the
	 * game can still save normally for the current session, it just won't
	 * persist across a reload.
	 */
	async function mountAndRestore(instance, assetMountPoint, log) {
		logFn = log || logFn;
		FS = instance.FS;
		saveDir = `${assetMountPoint.replace(/\/+$/, "")}/${SAVE_SUBDIR}`;

		try {
			FS.mkdirTree(saveDir);
		} catch (e) {
			if (!FS.analyzePath(saveDir).exists) throw e;
		}

		try {
			if (!FS.filesystems || !FS.filesystems.IDBFS) {
				throw new Error("IDBFS is not available in this build (missing -lidbfs.js?)");
			}
			const mountRoot = FS.mount(FS.filesystems.IDBFS, {}, saveDir);
			saveMount = mountRoot.mount;
			logFn(`[Save] Persistent filesystem mounted at ${saveDir}`, "info");
		} catch (err) {
			logFn(`[Save] ERROR: IDBFS unavailable (${err}); saves will not persist across reloads this session`, "stderr");
			// Keep saveDir pointing at the in-memory directory so import/export still work.
			// Only persistence is unavailable until the page is reloaded.
			onStateChange();
			setSaveButtonsReady(true);
			return;
		}

		logFn("[Save] Restoring saves from IndexedDB…", "info");
		try {
			await syncfsAsync(true);
			logFn("[Save] Restore complete", "info");
		} catch (err) {
			logFn(`[Save] ERROR: could not restore saves from IndexedDB: ${err}`, "stderr");
		}
		onStateChange(); // see comment in the failure branch above
		setSaveButtonsReady(true);
	}

	/** Developer control: sync now instead of waiting for the next save. */
	function forceSync() {
		return requestSync();
	}

	/** Download one native PC save slot (.b). */
	function exportSaveSlot(slot) {
		if (!FS || !saveDir) throw new Error("save directory is not available");
		if (!Number.isInteger(slot) || slot < 1 || slot > 8) throw new Error("Choose a slot from 1 to 8.");
		const name = `GTA3sf${slot}.b`;
		const path = `${saveDir}/${name}`;
		if (!FS.analyzePath(path).exists) throw new Error(`Save Slot ${slot} is empty.`);
		const blob = new Blob([FS.readFile(path)], { type: "application/octet-stream" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = name;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	/** Read all PC save slots as one portable JSON backup. */
	function exportSaveBundle() {
		if (!FS || !saveDir) throw new Error("save directory is not available");
		const saves = FS.readdir(saveDir)
			.filter((name) => /^GTA3sf[1-8]\.b$/i.test(name))
			.map((name) => ({
				name,
				data: bytesToBase64(FS.readFile(`${saveDir}/${name}`)),
			}));
		if (!saves.length) throw new Error("No GTA III save files were found in this browser.");
		return { format: "gta3-wasm-saves-v1", saves };
	}

	/** Import one native .b save, or a JSON bundle produced by exportSaveBundle(). */
	async function importSaveFile(file, targetSlot = 1) {
		if (!FS || !saveDir) throw new Error("save directory is not available");
		if (!Number.isInteger(targetSlot) || targetSlot < 1 || targetSlot > 8) {
			throw new Error("Choose a target slot from 1 to 8.");
		}
		const writes = [];
		if (/^GTA3sf[1-8]\.b$/i.test(file.name)) {
			if (file.size > 5 * 1024 * 1024) throw new Error("The save file is unexpectedly large.");
			writes.push([`GTA3sf${targetSlot}.b`, new Uint8Array(await file.arrayBuffer())]);
		} else if (/\.json$/i.test(file.name)) {
			if (file.size > 32 * 1024 * 1024) throw new Error("The save backup is too large.");
			const bundle = JSON.parse(await file.text());
			if (!bundle || bundle.format !== "gta3-wasm-saves-v1" || !Array.isArray(bundle.saves)) {
				throw new Error("This is not a GTA3-WASM save backup.");
			}
			for (const save of bundle.saves) {
				if (!save || !/^GTA3sf[1-8]\.b$/i.test(save.name) || typeof save.data !== "string" ||
					!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(save.data)) {
					throw new Error("The backup contains an invalid save entry.");
				}
				const binary = atob(save.data);
				if (binary.length > 5 * 1024 * 1024) throw new Error("A save file in the backup is unexpectedly large.");
				writes.push([save.name, Uint8Array.from(binary, (char) => char.charCodeAt(0))]);
			}
		} else {
			throw new Error("Choose a GTA3sf1.b–GTA3sf8.b save or a GTA3-WASM JSON backup.");
		}
		if (!writes.length) throw new Error("The backup contains no save files.");
		const existing = writes.filter(([name]) => FS.analyzePath(`${saveDir}/${name}`).exists);
		if (existing.length && !confirm(`Overwrite existing save slot(s): ${existing.map(([name]) => name).join(", ")}?`)) return false;
		for (const [name, data] of writes) FS.writeFile(`${saveDir}/${name}`, data);
		if (saveMount) {
			await requestSync();
			if (lastSyncResult === "failure") throw new Error(`Save import could not be persisted: ${lastSyncError}`);
		} else {
			logFn("[Save] Imported save is session-only; it may be lost after reload", "info");
		}
		return true;
	}

	/** Developer control: destructive -- caller (launcher.js) must confirm first. */
	async function clearSaves() {
		if (!FS || !saveDir) throw new Error("save directory not mounted");
		for (const name of FS.readdir(saveDir)) {
			if (name === "." || name === "..") continue;
			try {
				FS.unlink(`${saveDir}/${name}`);
			} catch {
				/* not a plain file (shouldn't happen under userfiles/) -- skip it */
			}
		}
		if (saveMount) await syncfsAsync(false);
		logFn("[Save] Browser saves cleared", "info");
	}

	function getStatus() {
		return {
			backend: FS && saveDir ? (saveMount ? "IDBFS" : "MEMFS (session-only)") : (FS ? "MEMFS (session-only)" : "not mounted"),
			saveDir,
			state,
			lastSyncResult,
			lastSyncError,
			lastSyncAt,
		};
	}

	function setOnStateChange(fn) {
		onStateChange = fn || (() => {});
	}

	function bytesToBase64(bytes) {
		let binary = "";
		const chunkSize = 0x8000;
		for (let i = 0; i < bytes.length; i += chunkSize) {
			binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
		}
		return btoa(binary);
	}

	// Add the save backup controls to the existing top bar without changing the
	// game's HTML structure. The file input opens the browser's native picker.
	let exportButton = null;
	let importButton = null;
	let importInput = null;
	let slotSelect = null;
	let downloadSlotButton = null;
	function setSaveButtonsReady(ready) {
		if (exportButton) exportButton.disabled = !ready;
		if (importButton) importButton.disabled = !ready;
		if (slotSelect) slotSelect.disabled = !ready;
		if (downloadSlotButton) downloadSlotButton.disabled = !ready;
	}

	function addSaveButtons() {
		const topbar = document.getElementById("topbar");
		if (!topbar || document.getElementById("save-export-btn")) return;
		exportButton = document.createElement("button");
		exportButton.id = "save-export-btn";
		exportButton.type = "button";
		exportButton.textContent = "Download saves";
		exportButton.title = "Download browser saves as a GTA3-WASM backup file";
		exportButton.disabled = true;
		importButton = document.createElement("button");
		importButton.id = "save-import-btn";
		importButton.type = "button";
		importButton.textContent = "Upload save";
		importButton.title = "Import a GTA III .b save into the selected slot, or restore a JSON bundle";
		importButton.disabled = true;
		slotSelect = document.createElement("select");
		slotSelect.id = "save-slot-select";
		slotSelect.title = "Target save slot";
		for (let slot = 1; slot <= 8; slot++) {
			const option = document.createElement("option");
			option.value = String(slot);
			option.textContent = `Slot ${slot}`;
			slotSelect.appendChild(option);
		}
		downloadSlotButton = document.createElement("button");
		downloadSlotButton.id = "save-slot-export-btn";
		downloadSlotButton.type = "button";
		downloadSlotButton.textContent = "Download slot";
		downloadSlotButton.title = "Download the selected native GTA III save slot";
		downloadSlotButton.disabled = true;
		importInput = document.createElement("input");
		importInput.type = "file";
		importInput.accept = ".b,.json,application/json";
		importInput.hidden = true;
		const spacer = topbar.querySelector(".spacer");
		topbar.insertBefore(exportButton, spacer || null);
		topbar.insertBefore(slotSelect, spacer || null);
		topbar.insertBefore(downloadSlotButton, spacer || null);
		topbar.insertBefore(importButton, spacer || null);
		topbar.appendChild(importInput);

		downloadSlotButton.addEventListener("click", () => {
			try {
				exportSaveSlot(Number(slotSelect.value));
			} catch (err) {
				alert(err.message || String(err));
			}
		});
		exportButton.addEventListener("click", () => {
			try {
				const bundle = exportSaveBundle();
				const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
				const link = document.createElement("a");
				link.href = URL.createObjectURL(blob);
				link.download = `gta3-saves-${new Date().toISOString().slice(0, 10)}.json`;
				link.click();
				setTimeout(() => URL.revokeObjectURL(link.href), 1000);
			} catch (err) {
				alert(err.message || String(err));
			}
		});
		importButton.addEventListener("click", () => importInput.click());
		importInput.addEventListener("change", async () => {
			const file = importInput.files && importInput.files[0];
			if (!file) return;
			importButton.disabled = true;
			try {
				const imported = await importSaveFile(file, Number(slotSelect.value));
				if (imported) alert("Save imported and synced to this browser. Reopen the game's Load Game menu to see it.");
			} catch (err) {
				alert(err.message || String(err));
				logFn(`[Save] ERROR: import failed: ${err.message || err}`, "stderr");
			} finally {
				importInput.value = "";
				importButton.disabled = false;
			}
		});
	}

	function getStatus() {
		return {
			backend: FS && saveDir ? (saveMount ? "IDBFS" : "MEMFS (session-only)") : (FS ? "MEMFS (session-only)" : "not mounted"),
			saveDir,
			state,
			lastSyncResult,
			lastSyncError,
			lastSyncAt,
		};
	}

	function setOnStateChange(fn) {
		onStateChange = fn || (() => {});
	}

	window.Re3Saves = {
		mountAndRestore,
		onSaveDirChanged,
		forceSync,
		clearSaves,
		exportSaveBundle,
		exportSaveSlot,
		importSaveFile,
		getStatus,
		setOnStateChange,
	};

	addSaveButtons();
})();
