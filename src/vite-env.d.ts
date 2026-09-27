/// <reference types="vite/client" />

// Build stamp injected by vite.config define (see CI staging step, which seds
// the same token over the built singlefile HTML).
declare const __BUILD_SHA__: string;
