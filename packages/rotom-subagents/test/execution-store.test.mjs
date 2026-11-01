import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const store = await import(pathToFileURL(path.join(import.meta.dirname, "../src/shared/execution-store.ts")));
const fresh = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rotom-execution-store-")));
const marker = (selected) => path.join(selected.baseRoot, store.EXECUTION_STORE_MARKER);
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });

test("supported POSIX platforms accept one consistent persisted device remap without rewriting the anchor", () => {
	const selected = store.initializeExecutionStore(path.join(fresh(), "base")), file = marker(selected), value = read(file);
	for (const field of ["device", "baseDevice", "leaseDevice", "sessionDevice"]) value[field] = String(BigInt(value[field]) + 2n);
	save(file, value); const before = fs.readFileSync(file);
	const reopened = store.resolveExecutionStore(selected.baseRoot, store.OWNED_EXECUTION_SCOPE);
	assert.equal(reopened.storeId, selected.storeId); assert.deepEqual(fs.readFileSync(file), before);
});

test("an inconsistent persisted device remap is rejected", () => {
	const selected = store.initializeExecutionStore(path.join(fresh(), "base")), file = marker(selected), value = read(file);
	value.device = String(BigInt(value.device) + 1n); save(file, value);
	assert.throws(() => store.resolveExecutionStore(selected.baseRoot, store.OWNED_EXECUTION_SCOPE), /identity drift/);
});

test("persisted device fields remain mandatory", () => {
	const selected = store.initializeExecutionStore(path.join(fresh(), "base")), file = marker(selected), value = read(file);
	delete value.device; save(file, value);
	assert.throws(() => store.resolveExecutionStore(selected.baseRoot, store.OWNED_EXECUTION_SCOPE), /identity drift/);
});

test("inode drift is still rejected when device topology is valid", () => {
	const selected = store.initializeExecutionStore(path.join(fresh(), "base")), file = marker(selected), value = read(file);
	value.inode = String(BigInt(value.inode) + 1n); save(file, value);
	assert.throws(() => store.resolveExecutionStore(selected.baseRoot, store.OWNED_EXECUTION_SCOPE), /identity drift/);
});

test("copying a complete store cannot import its binding into another base", () => {
	const selected = store.initializeExecutionStore(path.join(fresh(), "base")), copiedBase = path.join(fresh(), "base");
	fs.cpSync(selected.baseRoot, copiedBase, { recursive: true });
	fs.chmodSync(copiedBase, 0o700); fs.chmodSync(path.join(copiedBase, store.OWNED_EXECUTION_SCOPE), 0o700);
	fs.chmodSync(path.join(copiedBase, "session-leases"), 0o700); fs.chmodSync(path.join(copiedBase, store.OWNED_EXECUTION_SCOPE, "sessions"), 0o700);
	assert.throws(() => store.resolveExecutionStore(copiedBase, store.OWNED_EXECUTION_SCOPE), /identity drift/);
});

test("replacing the base is detected even when its children keep their inodes", () => {
	const selected = store.initializeExecutionStore(path.join(fresh(), "base")), parked = `${selected.baseRoot}-parked`;
	fs.renameSync(selected.baseRoot, parked); fs.mkdirSync(selected.baseRoot, { mode: 0o700 });
	for (const name of [store.OWNED_EXECUTION_SCOPE, "session-leases", store.EXECUTION_STORE_MARKER]) fs.renameSync(path.join(parked, name), path.join(selected.baseRoot, name));
	assert.equal(String(fs.statSync(selected.root, { bigint: true }).ino), selected.inode);
	assert.throws(() => store.resolveExecutionStore(selected.baseRoot, store.OWNED_EXECUTION_SCOPE), /identity drift/);
});
