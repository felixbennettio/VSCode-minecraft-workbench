import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Store } from '../src/store';
import { Minecraft } from '../src/minecraft';
import { manageInstances } from '../src/instance-actions';
import { instanceGroup, instanceGroups } from '../src/instance-groups';
import { LauncherActions } from '../src/launcher-actions';
import type { Instance } from '../src/models';

const vscode = require('vscode');
const jobs = {
  run: async (_name: unknown, work: Function) => work(new AbortController().signal, () => {}),
};
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-instance-groups-'));
  const store = new Store(root, () => {});
  store.state.instances = ['one', 'two', 'linked'].map(
    (id) =>
      ({
        id,
        name: id,
        directory: path.join(root, id),
        minecraft: '1.20.1',
        loader: 'fabric',
        createdAt: '',
        linked: id === 'linked',
      }) as Instance,
  );
  for (const instance of store.state.instances) {
    await fs.mkdir(instance.directory);
    await fs.writeFile(path.join(instance.directory, 'world.txt'), 'keep');
  }
  return {
    store,
    root,
    close: async () => {
      store.dispose();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test('group assignment persists without changing game files and renaming merges groups', async () => {
  const f = await fixture();
  const engine = {} as Minecraft;
  const actions = new LauncherActions(f.store, engine, { jobs } as never);
  try {
    await manageInstances(f.store, engine, jobs as never, {
      ids: ['one', 'two'],
      action: 'group',
      group: 'Survival',
    });
    await manageInstances(f.store, engine, jobs as never, {
      ids: ['linked'],
      action: 'group',
      group: 'Modpacks',
    });
    assert.deepEqual(instanceGroups(f.store.state.instances), ['Modpacks', 'Survival']);
    await actions.handle('launcher.renameGroup', { group: 'Survival', name: 'Modpacks' });
    assert.ok(f.store.state.instances.every((instance) => instance.group === 'Modpacks'));
    assert.ok(
      JSON.parse(await fs.readFile(path.join(f.root, 'state.json'), 'utf8')).instances.every(
        (instance: Instance) => instance.group === 'Modpacks',
      ),
    );
    for (const instance of f.store.state.instances)
      assert.equal(await fs.readFile(path.join(instance.directory, 'world.txt'), 'utf8'), 'keep');
    await manageInstances(f.store, engine, jobs as never, {
      ids: ['one', 'two', 'linked'],
      action: 'group',
      group: '',
    });
    assert.deepEqual(instanceGroups(f.store.state.instances), []);
    await assert.rejects(
      manageInstances(f.store, engine, jobs as never, {
        ids: ['unknown'],
        action: 'group',
        group: 'A',
      }),
      /not found/,
    );
    assert.throws(() => instanceGroup('bad\nname'));
  } finally {
    await f.close();
  }
});

test('failed group persistence restores the previous group for all selected instances', async () => {
  const f = await fixture();
  const save = mock.method(f.store, 'save', async () => {
    throw new Error('write failed');
  });
  try {
    await assert.rejects(
      manageInstances(f.store, {} as never, jobs as never, {
        ids: ['one', 'two'],
        action: 'group',
        group: 'A',
      }),
      /write failed/,
    );
    assert.ok(f.store.state.instances.every((instance) => instance.group === undefined));
  } finally {
    save.mock.restore();
    await f.close();
  }
});

test('bulk deletion confirms once, keeps linked files and rejects running instances before prompting', async () => {
  const f = await fixture();
  const engine = new Minecraft(
    f.store,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    () => {},
  );
  vscode.window.showWarningMessage ||= async () => {};
  vscode.workspace.fs ||= {};
  vscode.workspace.fs.delete ||= async () => {};
  const confirm = mock.method(vscode.window, 'showWarningMessage', async () => undefined);
  const remove = mock.method(
    vscode.workspace.fs,
    'delete',
    async (uri: { fsPath: string }, options: { useTrash: boolean }) => {
      assert.equal(options.useTrash, true);
      await fs.rm(uri.fsPath, { recursive: true });
    },
  );
  try {
    confirm.mock.mockImplementation(async (...args: unknown[]) => args[2]);
    const removed = await manageInstances(f.store, engine, jobs as never, {
      ids: ['one'],
      action: 'remove',
    });
    assert.equal(removed.changed, 1);
    assert.equal(remove.mock.callCount(), 0);
    assert.equal(await fs.readFile(path.join(f.root, 'one', 'world.txt'), 'utf8'), 'keep');
    f.store.state.instances.unshift({
      id: 'one',
      name: 'one',
      directory: path.join(f.root, 'one'),
      minecraft: '1.20.1',
      loader: 'fabric',
      createdAt: '',
    } as Instance);
    confirm.mock.mockImplementation(async () => undefined);
    confirm.mock.resetCalls();
    const request = { ids: ['one', 'two', 'linked'], action: 'delete' };
    await manageInstances(f.store, engine, jobs as never, request);
    assert.equal(f.store.state.instances.length, 3);
    assert.equal(remove.mock.callCount(), 0);
    engine.running.set('two', {} as never);
    await assert.rejects(
      manageInstances(f.store, engine, jobs as never, request),
      /Stop this instance/,
    );
    assert.equal(confirm.mock.callCount(), 1);
    engine.running.clear();
    confirm.mock.mockImplementation(async (...args: unknown[]) => args[2]);
    const result = await manageInstances(f.store, engine, jobs as never, request);
    assert.equal(result.changed, 3);
    assert.deepEqual(f.store.state.instances, []);
    assert.equal(remove.mock.callCount(), 2);
    assert.equal(await fs.readFile(path.join(f.root, 'linked', 'world.txt'), 'utf8'), 'keep');
  } finally {
    confirm.mock.restore();
    remove.mock.restore();
    await f.close();
  }
});

test('remove keeps every file while delete trashes only the in-place version folder it owns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-instance-delete-'));
  const store = new Store(path.join(root, 'state'), () => {});
  const game = path.join(root, '.minecraft');
  const version = (id: string, profile: Record<string, unknown> = {}) =>
    fs
      .mkdir(path.join(game, 'versions', id), { recursive: true })
      .then(() =>
        fs.writeFile(
          path.join(game, 'versions', id, `${id}.json`),
          JSON.stringify({ id, ...profile }),
        ),
      );
  await version('1.20.1');
  await version('Pack', { inheritsFrom: '1.20.1' });
  await version('Solo');
  await fs.mkdir(path.join(game, 'libraries'), { recursive: true });
  await fs.writeFile(path.join(game, 'libraries', 'shared.jar'), 'keep');
  const linked = (id: string, versionId: string, directory = path.join(game, 'versions', versionId)) =>
    ({
      id,
      name: id,
      directory,
      runtimeDirectory: game,
      versionId,
      preserveVersion: true,
      linked: true,
      minecraft: '1.20.1',
      loader: 'vanilla',
      createdAt: '',
    }) as Instance;
  store.state.instances = [
    linked('base', '1.20.1', game),
    linked('pack', 'Pack'),
    linked('solo', 'Solo'),
    linked('kept', 'Solo'),
  ];
  const engine = new Minecraft(store, {} as never, {} as never, {} as never, {} as never, () => {});
  vscode.workspace.fs ||= {};
  vscode.workspace.fs.delete ||= async () => {};
  const trashed: string[] = [];
  const remove = mock.method(
    vscode.workspace.fs,
    'delete',
    async (uri: { fsPath: string }, options: { useTrash: boolean }) => {
      assert.equal(options.useTrash, true);
      trashed.push(uri.fsPath);
      await fs.rm(uri.fsPath, { recursive: true });
    },
  );
  const byId = (id: string) => store.state.instances.find((instance) => instance.id === id)!;
  try {
    assert.deepEqual(await engine.deletionTargets(byId('base')), []);
    assert.deepEqual(await engine.deletionTargets(byId('solo')), []);
    await engine.remove(byId('kept'));
    assert.deepEqual(trashed, []);
    assert.ok(await fs.stat(path.join(game, 'versions', 'Solo')));
    assert.deepEqual(await engine.deletionTargets(byId('solo')), [
      path.join(game, 'versions', 'Solo'),
    ]);
    await engine.delete(byId('solo'));
    await engine.delete(byId('base'));
    assert.deepEqual(trashed, [path.join(game, 'versions', 'Solo')]);
    assert.deepEqual(await engine.deletionTargets(byId('pack')), [
      path.join(game, 'versions', 'Pack'),
    ]);
    assert.equal(await fs.readFile(path.join(game, 'libraries', 'shared.jar'), 'utf8'), 'keep');
    assert.ok(await fs.stat(path.join(game, 'versions', '1.20.1')));
    assert.deepEqual(
      store.state.instances.map((instance) => instance.id),
      ['pack'],
    );
  } finally {
    remove.mock.restore();
    store.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bulk repair reports per-instance failures without skipping other selected instances', async () => {
  const f = await fixture();
  const visited: string[] = [];
  try {
    const result = await manageInstances(
      f.store,
      {
        install: async (instance: Instance) => {
          visited.push(instance.id);
          if (instance.id === 'two') throw new Error('busy');
        },
      } as never,
      jobs as never,
      { ids: ['one', 'two', 'linked'], action: 'repair' },
    );
    assert.equal(result.changed, 2);
    assert.equal(result.failed[0].id, 'two');
    assert.deepEqual(visited, ['one', 'two', 'linked']);
  } finally {
    await f.close();
  }
});
