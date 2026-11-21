import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesktopHostUpdateInfo, UpdateCheckResponse } from '../api';
import { compareUpdateSemver, hasCoreUpdate, resolveUpdatePlan } from './updateRouting.ts';

function makeDesktopHost(overrides: Partial<DesktopHostUpdateInfo> = {}): DesktopHostUpdateInfo {
  return {
    shell_version: '7.5.2-beta.0',
    legacy_shell: false,
    bundle_type: 'nsis',
    native_updater_supported: true,
    signed_updater_ready: true,
    binary_writable: true,
    min_shell_version: '7.5.0',
    latest_shell_version: '7.5.2-beta.0',
    shell_changed: false,
    shell_has_update: false,
    shell_update_required: false,
    updater_json_url: 'https://github.com/jeikl/JeikCode/releases/download/v7.5.3/desktop-updater.json',
    installer_url: 'https://github.com/jeikl/JeikCode/releases/download/v7.5.3/JeikCode.Desktop_7.5.3_x64-setup.exe',
    installer_sha256: 'abc123',
    installer_size: 1024,
    proxy_url: null,
    ...overrides,
  };
}

function makeInfo(overrides: Partial<UpdateCheckResponse> = {}): UpdateCheckResponse {
  return {
    current_version: 'v7.5.2-beta.0',
    latest_version: 'v7.5.3',
    has_update: true,
    is_desktop: true,
    channel: 'stable',
    desktop_host: makeDesktopHost(),
    ...overrides,
  };
}

test('compareUpdateSemver compares beta numbers numerically', () => {
  assert.equal(compareUpdateSemver('v7.5.2-beta.10', '7.5.2-beta.2'), true);
  assert.equal(compareUpdateSemver('v7.5.2-beta.2', '7.5.2-beta.10'), false);
  assert.equal(compareUpdateSemver('7.5.2', '7.5.2-beta.10'), true);
});

test('top-bar green badge only follows core updates, not shell-only updates', () => {
  const shellOnly = makeInfo({
    current_version: 'v7.5.2-beta.4',
    latest_version: 'v7.5.2-beta.4',
    has_update: false,
    desktop_host: makeDesktopHost({
      shell_version: '7.5.2-beta.0',
      latest_shell_version: '7.5.2-beta.4',
      shell_has_update: true,
    }),
  });
  assert.equal(hasCoreUpdate(shellOnly), false);
  assert.equal(hasCoreUpdate(makeInfo({ has_update: true })), true);
});

test('remote browser always routes to Path A and ignores desktop shell updates', () => {
  const plan = resolveUpdatePlan({
    info: makeInfo({
      desktop_host: makeDesktopHost({
        shell_changed: true,
        shell_has_update: true,
        shell_update_required: true,
      }),
    }),
    targetVersion: 'v7.5.3',
    isLatestPick: true,
    forceReinstall: false,
    inDesktopWindow: false,
    hasTauriIpc: false,
  });
  assert.equal(plan.defaultMode, 'binary');
  assert.equal(plan.canPathA, true);
  assert.equal(plan.canPathB, false);
  assert.equal(plan.remoteReadonlyBlocked, false);
});

test('remote browser flags read-only desktop host like AppImage', () => {
  const plan = resolveUpdatePlan({
    info: makeInfo({
      desktop_host: makeDesktopHost({
        bundle_type: 'appimage',
        binary_writable: false,
        shell_has_update: true,
        shell_update_required: true,
      }),
    }),
    targetVersion: 'v7.5.3',
    isLatestPick: true,
    forceReinstall: false,
    inDesktopWindow: false,
    hasTauriIpc: false,
  });
  assert.equal(plan.remoteReadonlyBlocked, true);
  assert.equal(plan.canPathA, false);
});

test('local desktop prefers Path A when shell did not change and binary is writable', () => {
  const plan = resolveUpdatePlan({
    info: makeInfo({
      desktop_host: makeDesktopHost({
        shell_changed: false,
        shell_has_update: false,
      }),
    }),
    targetVersion: 'v7.5.3',
    isLatestPick: true,
    forceReinstall: false,
    inDesktopWindow: true,
    hasTauriIpc: true,
  });
  assert.equal(plan.defaultMode, 'binary');
  assert.equal(plan.canPathA, true);
  assert.equal(plan.canPathB, true);
  assert.equal(plan.pathBEngine, 'tauri_native');
});

test('local desktop enforces Path B when shell_update_required or AppImage read-only', () => {
  const plan = resolveUpdatePlan({
    info: makeInfo({
      desktop_host: makeDesktopHost({
        bundle_type: 'appimage',
        binary_writable: false,
        shell_has_update: true,
        shell_update_required: true,
      }),
    }),
    targetVersion: 'v7.5.3',
    isLatestPick: true,
    forceReinstall: false,
    inDesktopWindow: true,
    hasTauriIpc: true,
  });
  assert.equal(plan.defaultMode, 'desktop');
  assert.equal(plan.canPathA, false);
  assert.equal(plan.canPathB, true);
  assert.equal(plan.shellRequired, true);
  assert.equal(plan.pathBEngine, 'tauri_native');
});

test('legacy shell executes Step 1 (Path A) first, then Step 2 (backend_assisted Path B)', () => {
  const step1 = resolveUpdatePlan({
    info: makeInfo({
      has_update: true,
      desktop_host: makeDesktopHost({
        shell_version: null,
        legacy_shell: true,
        signed_updater_ready: false,
        shell_has_update: true,
      }),
    }),
    targetVersion: 'v7.5.3',
    isLatestPick: true,
    forceReinstall: false,
    inDesktopWindow: true,
    hasTauriIpc: false,
  });
  assert.equal(step1.defaultMode, 'binary');
  assert.equal(step1.canPathA, true);

  const step2 = resolveUpdatePlan({
    info: makeInfo({
      current_version: 'v7.5.3',
      has_update: false,
      desktop_host: makeDesktopHost({
        shell_version: null,
        legacy_shell: true,
        signed_updater_ready: false,
        shell_has_update: true,
      }),
    }),
    targetVersion: 'v7.5.3',
    isLatestPick: true,
    forceReinstall: false,
    inDesktopWindow: true,
    hasTauriIpc: false,
  });
  assert.equal(step2.defaultMode, 'desktop');
  assert.equal(step2.legacyStep2Ready, true);
  assert.equal(step2.pathBEngine, 'backend_assisted');
});

test('Linux deb falls back to manual installer download', () => {
  const plan = resolveUpdatePlan({
    info: makeInfo({
      desktop_host: makeDesktopHost({
        bundle_type: 'deb',
        native_updater_supported: false,
        signed_updater_ready: false,
        binary_writable: false,
        shell_has_update: true,
        shell_update_required: true,
        installer_url: 'https://github.com/jeikl/JeikCode/releases/download/v7.5.3/JeikCode.Desktop_7.5.3_amd64.deb',
      }),
    }),
    targetVersion: 'v7.5.3',
    isLatestPick: true,
    forceReinstall: false,
    inDesktopWindow: true,
    hasTauriIpc: true,
  });
  assert.equal(plan.defaultMode, 'desktop');
  assert.equal(plan.pathBEngine, 'manual');
});
