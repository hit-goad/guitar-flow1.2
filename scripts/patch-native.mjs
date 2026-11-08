#!/usr/bin/env node
/**
 * 在 `npx cap add android/ios` 之后补齐原生权限与配置。
 * 幂等：重复运行不会重复插入。
 */
import { readFile, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function patchAndroid() {
  const manifestPath = join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!(await exists(manifestPath))) {
    console.log('[patch-native] 未找到 AndroidManifest.xml，跳过');
    return;
  }
  let xml = await readFile(manifestPath, 'utf8');
  const perms = [
    'android.permission.INTERNET',
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
  ];
  let added = [];
  for (const p of perms) {
    if (!xml.includes(`android:name="${p}"`)) {
      added.push(p);
    }
  }
  if (added.length) {
    const block = added.map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
    xml = xml.replace(/<manifest([^>]*)>/, `<manifest$1>\n${block}`);
  }
  if (!xml.includes('android:usesCleartextTraffic')) {
    xml = xml.replace(/<application([^>]*)>/, '<application$1\n        android:usesCleartextTraffic="true">');
  }
  await writeFile(manifestPath, xml);
  console.log(`[patch-native] Android 权限已补齐：${added.join(', ') || '无需变更'}`);

  // 允许 http 明文（部分谱站镜像没有 https）
  const netConfig = join(root, 'android', 'app', 'src', 'main', 'res', 'xml', 'network_security_config.xml');
  if (!(await exists(netConfig))) {
    await writeFile(
      netConfig,
      `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true" />
</network-security-config>`,
      'utf8',
    );
    let m2 = await readFile(manifestPath, 'utf8');
    if (!m2.includes('networkSecurityConfig')) {
      m2 = m2.replace(/<application([^>]*)>/, '<application$1\n        android:networkSecurityConfig="@xml/network_security_config">');
      await writeFile(manifestPath, m2);
    }
  }
}

async function patchIos() {
  const plistPath = join(root, 'ios', 'App', 'App', 'Info.plist');
  if (!(await exists(plistPath))) {
    console.log('[patch-native] 未找到 iOS Info.plist，跳过');
    return;
  }
  let plist = await readFile(plistPath, 'utf8');
  const entries = [
    ['NSMicrophoneUsageDescription', 'GuitarFlow 需要麦克风来实时检测你弹奏的音高。'],
    ['UIFileSharingEnabled', null],
    ['LSSupportsOpeningDocumentsInPlace', null],
  ];
  let changed = false;
  for (const [key, value] of entries) {
    if (plist.includes(`<key>${key}</key>`)) continue;
    const insertion =
      value === null
        ? `\t<key>${key}</key>\n\t<true/>\n`
        : `\t<key>${key}</key>\n\t<string>${value}</string>\n`;
    plist = plist.replace(/<\/dict>\s*<\/plist>/, `${insertion}</dict>\n</plist>`);
    changed = true;
  }
  await writeFile(plistPath, plist);
  console.log(`[patch-native] iOS Info.plist ${changed ? '已补齐麦克风与文件共享配置' : '无需变更'}`);
}

await patchAndroid();
await patchIos();
console.log('[patch-native] 完成');