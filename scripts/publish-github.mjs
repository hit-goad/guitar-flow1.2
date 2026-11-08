#!/usr/bin/env node
/**
 * 一条命令创建 GitHub 仓库并推送，然后触发三端打包。
 *
 * 用法（需要一个有 repo 权限的 token）：
 *   GH_TOKEN=ghp_xxx node scripts/publish-github.mjs --repo guitarflow --private
 *
 * 也可以用已有的远端：
 *   git remote add origin git@github.com:user/repo.git && git push -u origin main
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const repo = arg('repo', 'guitarflow');
const priv = flag('private');
const description =
  arg('desc', '跨平台吉他谱跟练：谱面跟随滚动、逐音符音高、内录与实时音高检测、多源搜谱与智能导入');

if (!token) {
  console.error(
    [
      '缺少 token：设置环境变量 GH_TOKEN 后再运行。',
      '',
      '  Windows (PowerShell):  $env:GH_TOKEN="ghp_xxx"; node scripts/publish-github.mjs --repo guitarflow',
      '  macOS / Linux:         GH_TOKEN=ghp_xxx node scripts/publish-github.mjs --repo guitarflow',
      '',
      'token 权限：repo（勾选 public_repo 或 repo 整项）。',
      '也可以不用本脚本：手动在网页建仓后执行',
      '  git remote add origin https://github.com/<你>/<repo>.git',
      '  git push -u origin main && git tag v1.0.0 && git push --tags',
    ].join('\n'),
  );
  process.exit(2);
}

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'guitarflow-publish',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
};

const me = await api('/user');
if (!me.ok) {
  console.error(`token 无效或网络不可达：HTTP ${me.status} ${me.text?.slice(0, 200)}`);
  process.exit(1);
}
const owner = me.json.login;
console.log(`已认证：${owner}`);

let created = await api('/user/repos', {
  method: 'POST',
  body: JSON.stringify({ name: repo, description, private: priv, auto_init: false, has_issues: true }),
});

if (!created.ok && created.status === 422) {
  const existing = await api(`/repos/${owner}/${repo}`);
  if (existing.ok) {
    console.log(`仓库已存在，直接推送：${existing.json.html_url}`);
    created = existing;
  }
}
if (!created.ok) {
  console.error(`创建仓库失败：HTTP ${created.status} ${created.text?.slice(0, 300)}`);
  process.exit(1);
}

const fullName = created.json.full_name;
const htmlUrl = created.json.html_url;
const cloneUrl = created.json.clone_url;

const run = (bin, argv) => {
  try {
    const out = execFileSync(bin, argv, { stdio: 'pipe', encoding: 'utf8' });
    return out.trim();
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || String(err.message);
  }
};

// 配置远端（带 token，避免交互式登录）
const authed = `https://x-access-token:${token}@github.com/${fullName}.git`;
run('git', ['remote', 'remove', 'origin']);
run('git', ['remote', 'add', 'origin', authed]);

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
console.log(`推送 ${branch} …`);
console.log(run('git', ['push', '-u', 'origin', branch]));

const tags = run('git', ['tag', '--list']);
if (tags) {
  const verTag = tags.split('\n').filter((t) => /^v\d/.test(t)).pop();
  if (verTag) {
    console.log(`推送标签 ${verTag}（触发 Release 打包）…`);
    console.log(run('git', ['push', 'origin', verTag]));
  }
}

// 把远端地址还原成不带 token 的形式
run('git', ['remote', 'set-url', 'origin', cloneUrl]);

console.log(
  [
    '',
    '完成。',
    `仓库：${htmlUrl}`,
    `Actions：${htmlUrl}/actions`,
    '',
    'Android 安装包跑完后在 Actions 页面下载 guitarflow-android（.apk/.aab）；',
    'Windows 安装包在 guitarflow-windows；iOS 未签名 IPA 在 guitarflow-ios。',
    '打标签后的产物会直接挂到 Releases。',
  ].join('\n'),
);