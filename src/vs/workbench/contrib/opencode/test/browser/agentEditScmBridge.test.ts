/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: vscode test convention
import * as assert from "assert";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../../../base/test/common/utils.js";
import type { ISCMRepository, ISCMResource, ISCMResourceGroup, ISCMService } from "../../../scm/common/scm.js";
import { AgentEditScmBridge } from "../../browser/agentEditScmBridge.js";
import type { IAgentEditTracker } from "../../common/agentEditTracker.js";
import type { HunkRange } from "../../common/opencodeSessionsTypes.js";

const repoRoot = URI.file("/workspace/repo");
const repoFile = URI.file("/workspace/repo/file.ts");
const repoSiblingFile = URI.file("/workspace/repo-other/file.ts");
const repoARoot = URI.file("/workspace/repo-a");
const repoAFile = URI.file("/workspace/repo-a/file.ts");
const repoBRoot = URI.file("/workspace/repo-b");
const repoBFile = URI.file("/workspace/repo-b/file.ts");

class TestSCMProvider extends Disposable {
 private readonly _onDidChangeResources = this._register(new Emitter<void>());
 readonly onDidChangeResources = this._onDidChangeResources.event;
 groups: readonly ISCMResourceGroup[] = [];

 constructor(readonly rootUri: URI | undefined, resources: readonly URI[] = []) {
  super();
  this.setDirtyResources(resources);
 }

 setDirtyResources(resources: readonly URI[]): void {
  this.groups = [{ resources: resources.map((uri) => ({ sourceUri: uri }) as unknown as ISCMResource) } as unknown as ISCMResourceGroup];
 }

 fireDidChangeResources(): void {
  this._onDidChangeResources.fire();
 }
}

class TestSCMRepository extends Disposable {
 readonly provider: TestSCMProvider;

 constructor(readonly id: string, rootUri: URI | undefined, resources: readonly URI[] = []) {
  super();
  this.provider = this._register(new TestSCMProvider(rootUri, resources));
 }
}

class TestSCMService extends Disposable {
 declare readonly _serviceBrand: undefined;

 private readonly _onDidAddRepository = this._register(new Emitter<ISCMRepository>());
 readonly onDidAddRepository = this._onDidAddRepository.event;
 private readonly _onDidRemoveRepository = this._register(new Emitter<ISCMRepository>());
 readonly onDidRemoveRepository = this._onDidRemoveRepository.event;
 private readonly _repositories: TestSCMRepository[];

 constructor(repositories: readonly TestSCMRepository[] = []) {
  super();
  this._repositories = [...repositories];
 }

 get repositories(): readonly ISCMRepository[] {
  return this._repositories.map((repository) => repository as unknown as ISCMRepository);
 }

 addRepository(repository: TestSCMRepository): void {
  this._repositories.push(repository);
  this._onDidAddRepository.fire(repository as unknown as ISCMRepository);
 }

 removeRepository(repository: TestSCMRepository): void {
  const index = this._repositories.indexOf(repository);
  if (index >= 0) {
   this._repositories.splice(index, 1);
  }
  this._onDidRemoveRepository.fire(repository as unknown as ISCMRepository);
 }
}

class TestAgentEditTracker implements IAgentEditTracker {
 declare readonly _serviceBrand: undefined;
 readonly onDidChange = Event.None;
 readonly removedUris: URI[] = [];
 trackedUriReadCount = 0;

 constructor(private _trackedUris: readonly URI[] = []) { }

 get trackedUris(): readonly URI[] {
  this.trackedUriReadCount++;
  return this._trackedUris;
 }

 setTrackedUris(uris: readonly URI[]): void {
  this._trackedUris = uris;
 }

 markModified(_uri: URI, _hunks?: readonly HunkRange[], _editedAt?: number): void { }

 attachHunks(_uri: URI, _hunks: readonly HunkRange[], _editedAt: number): void { }

 markViewed(_uri: URI): void { }

 markRemoved(uri: URI): void {
  this.removedUris.push(uri);
  this._trackedUris = this._trackedUris.filter((trackedUri) => trackedUri.toString() !== uri.toString());
 }

 clear(): void { }

 getEntry(): undefined {
  return undefined;
 }
}

async function waitForDebounce(): Promise<void> {
 await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

suite("AgentEditScmBridge", () => {
 const disposables = ensureNoDisposablesAreLeakedInTestSuite();

 function createRepository(id: string, rootUri: URI | undefined, resources: readonly URI[] = []): TestSCMRepository {
  return disposables.add(new TestSCMRepository(id, rootUri, resources));
 }

 function createHarness(repositories: readonly TestSCMRepository[] = [], trackedUris: readonly URI[] = []) {
  const scmService = disposables.add(new TestSCMService(repositories));
  const tracker = new TestAgentEditTracker(trackedUris);
  const bridge = disposables.add(new AgentEditScmBridge(scmService as unknown as ISCMService, tracker, 0));
  return { bridge, scmService, tracker };
 }

 test("empty SCM service leaves tracked URIs untouched", async () => {
  const harness = createHarness([], [repoFile]);

  await waitForDebounce();

  assert.deepStrictEqual(harness.tracker.removedUris, []);
  assert.strictEqual(harness.tracker.trackedUriReadCount, 0);
 });

 test("single repo preserves a tracked URI while it remains dirty", async () => {
  const repository = createRepository("repo", repoRoot, [repoFile]);
  const harness = createHarness([repository], [repoFile]);

  repository.provider.fireDidChangeResources();
  await waitForDebounce();

  assert.deepStrictEqual(harness.tracker.removedUris, []);
 });

 test("single repo clears a tracked URI once it leaves the dirty set", async () => {
  const repository = createRepository("repo", repoRoot);
  const harness = createHarness([repository], [repoFile]);

  repository.provider.fireDidChangeResources();
  await waitForDebounce();

  assert.deepStrictEqual(harness.tracker.removedUris, [repoFile]);
 });

 test("tracked URI outside any repository root is never auto-cleared", async () => {
  const repository = createRepository("repo", repoRoot);
  const harness = createHarness([repository], [repoSiblingFile]);

  repository.provider.fireDidChangeResources();
  await waitForDebounce();

  assert.deepStrictEqual(harness.tracker.removedUris, []);
 });

 test("multi-repo dirty scan clears only the clean repository URI", async () => {
  const repoA = createRepository("repo-a", repoARoot);
  const repoB = createRepository("repo-b", repoBRoot, [repoBFile]);
  const harness = createHarness([repoA, repoB], [repoAFile, repoBFile]);

  repoA.provider.fireDidChangeResources();
  await waitForDebounce();

  assert.deepStrictEqual(harness.tracker.removedUris, [repoAFile]);
 });

 test("repository added after startup is watched", async () => {
  const repository = createRepository("repo", repoRoot);
  const harness = createHarness([], [repoFile]);

  harness.scmService.addRepository(repository);
  repository.provider.fireDidChangeResources();
  await waitForDebounce();

  assert.deepStrictEqual(harness.tracker.removedUris, [repoFile]);
 });

 test("removed repository is unsubscribed from resource changes", async () => {
  const repository = createRepository("repo", repoRoot);
  const harness = createHarness([repository], [repoFile]);

  harness.scmService.removeRepository(repository);
  repository.provider.fireDidChangeResources();
  await waitForDebounce();

  assert.deepStrictEqual(harness.tracker.removedUris, []);
 });

 test("rapid resource changes are debounced into one tracker pass", async () => {
  const repository = createRepository("repo", repoRoot, [repoFile]);
  const harness = createHarness([repository], [repoFile]);

  repository.provider.fireDidChangeResources();
  repository.provider.fireDidChangeResources();
  repository.provider.fireDidChangeResources();
  repository.provider.fireDidChangeResources();
  repository.provider.fireDidChangeResources();
  await waitForDebounce();

  assert.strictEqual(harness.tracker.trackedUriReadCount, 1);
  assert.deepStrictEqual(harness.tracker.removedUris, []);
 });

 test("disposing the bridge unsubscribes SCM listeners", async () => {
  const repository = createRepository("repo", repoRoot);
  const addedRepository = createRepository("added", repoARoot);
  const harness = createHarness([repository], [repoFile, repoAFile]);

  harness.bridge.dispose();
  repository.provider.fireDidChangeResources();
  harness.scmService.addRepository(addedRepository);
  addedRepository.provider.fireDidChangeResources();
  await waitForDebounce();

  assert.deepStrictEqual(harness.tracker.removedUris, []);
 });
});
