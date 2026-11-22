# Browser Settings and Memory Controls

The browser shell exposes performance controls without replacing the existing
native game settings or the original input, save, diagnostics, and asset-loading
flows.

## Graphics quality

The top-bar **Settings** panel offers three presets and a Custom mode:

| Preset | LOD / draw-distance scale | Motion trails |
|---|---:|---|
| Performance | 0.8x | Off |
| Balanced (default) | 1.2x | On |
| High | 1.8x | On |
| Custom | User selected | User selected |

The LOD range matches the engine's existing frontend slider (0.8–1.8), and
motion trails use the existing `CMBlur::BlurOn` setting. Texture filtering,
anisotropic filtering, and MSAA are not exposed here because this WebAssembly
build does not currently enable those native options.

## FPS limit

The browser engine scheduler accepts 30, 40, or 50 FPS; 50 is the default.
The same scheduler governs both the frontend and gameplay. Changing the
setting resets its next-frame deadline so the old schedule does not delay the
new target. The non-Emscripten/native limiter path is unchanged.

## Render scale

The canvas backing dimensions are multiplied by 50%, 75%, or 100% of the
normal CSS-size-times-device-pixel-ratio dimensions. This reduces the canvas
color-buffer footprint approximately with the square of the scale (before
other WebGL attachments and driver allocations). The canvas continues to fill
the same CSS viewport.

The diagnostics panel reports the canvas RGBA color-buffer lower-bound
estimate. This is not a measurement of total GPU memory; depth/stencil buffers,
driver allocations, and presentation surfaces add more.

## Streaming model-cache budget

The Low, Balanced, and High memory choices set the engine streaming cache
budget to 80, 123, or 160 MiB respectively. Balanced (123 MiB) matches the
existing Emscripten assumption based on 256 MiB of available physical memory.
The engine recalculates its desired number of loaded vehicles for the selected
budget. A lower budget does not instantly destroy referenced resources: normal
streaming eviction releases eligible objects as later loading requests need
space.

This is specifically the game's streaming model-cache budget, not a hard cap on
total WebAssembly, JavaScript, browser, or GPU memory. High mode can increase
memory use and should only be selected when the browser/device has headroom.

## Memory diagnostics

The Diagnostics panel reports, where the browser exposes them:

- WASM linear-memory buffer size (the module's current WebAssembly memory).
- JavaScript heap size in Chromium-based browsers that expose
  `performance.memory`.
- Canvas RGBA color-buffer lower-bound estimate.
- Streaming model-cache usage and configured budget.
- Number and summed file sizes of files in the mounted game VFS.

These measurements describe different memory domains and must not be added
together as if they were a single exact browser-process measurement. In
particular, VFS file sizes are a logical sum of file contents, not a direct
measurement of resident physical memory.

## Asset import memory behavior and limitation

Folder import now reads one browser File at a time, writes it into Emscripten's
virtual filesystem, and periodically yields to the browser event loop. It avoids
creating a second full array of File references and avoids keeping a folder-wide
JavaScript byte array. This reduces transient import overhead and improves UI
responsiveness.

The game assets themselves are still mounted in the Emscripten virtual
filesystem. They are therefore not fully on-demand disk streamed by this
change. re3's current C++ file-access path expects synchronous filesystem
reads; a true disk-backed on-demand asset system needs a separate architecture
change (for example, moving the file I/O/runtime to a worker-compatible
design). This setting work deliberately does not pretend that IndexedDB
persistence alone removes runtime asset residency.

## Safety and compatibility fixes

- The temporary WebGL capability-probe canvas releases its context after
  collecting the version string, avoiding an unnecessary extra live context
  alongside the game's renderer.
- `CStreaming::MakeSpaceFor()` now guards the unsigned subtraction used when
  one requested model is at least as large as the configured cache budget. This
  avoids a size_t underflow in the cache-space calculation.
- Settings are stored in browser `localStorage` under
  `re3-browser-settings-v1`; they do not overwrite the game's `gta3.set`
  configuration or save files.

## Rebuild requirement

The web UI can be loaded from the updated source immediately, but the FPS,
graphics, and streaming-budget C++ exports are only present after rebuilding
the WASM binary. With Emscripten activated, run:

```bash
cmake --build build-wasm --target re3_wasm --parallel 4
```

Then serve the updated `web/` directory and reload the browser page. A
previously generated `web/build/re3_wasm.js` / `.wasm` pair will not contain
these new native exports.
