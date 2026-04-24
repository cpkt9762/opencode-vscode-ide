/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * Derive a stable port number from a string key using FNV-1a hash.
 * Port range: 49152-65535 (dynamic/private ports).
 */
export function stablePort(backend: string) {
	let hash = 0x811c9dc5;

	for (let index = 0; index < backend.length; index++) {
		hash ^= backend.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}

	return 49152 + (hash % 16384);
}
