#!/usr/bin/env node
'use strict';
/*
 * feedback-review.js — HUMAN approval gate for AI feedback proposals.
 *
 * The worker only ever PROPOSES (branch + draft reply). Nothing is merged, deployed,
 * or sent until a human runs one of these:
 *
 *   node scripts/feedback-review.js list                 # pending proposals
 *   node scripts/feedback-review.js list --all           # include resolved/rejected
 *   node scripts/feedback-review.js show <id>            # feedback + decision + full diff
 *   node scripts/feedback-review.js approve <id>         # accept: merge branch (if any) -> master, mark resolved
 *   node scripts/feedback-review.js reject <id> [reason]  # discard branch, mark rejected
 *   node scripts/feedback-review.js reply <id> [text]    # mark replied w/o code change (optionally edit reply)
 *
 * approve MERGES into master (which the live bridge serves from) but never pushes,
 * never restarts the bridge, and never auto-sends the reply. It prints the reply text
 * and the user's contact so you can relay it.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PROPOSALS_DIR = path.join(REPO, 'data', 'proposals');

function git(args) { return spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }); }
function listProposals() {
  if (!fs.existsSync(PROPOSALS_DIR)) return [];
  return fs.readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(PROPOSALS_DIR, f), 'utf8')); } catch (_) { return null; } })
    .filter(Boolean).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}
function save(p) { fs.writeFileSync(path.join(PROPOSALS_DIR, `${p.id}.json`), JSON.stringify(p, null, 2)); }
function find(id) {
  const f = path.join(PROPOSALS_DIR, `${id}.json`);
  if (!fs.existsSync(f)) { console.error(`no proposal ${id}`); process.exit(1); }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
const C = { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m` };

function cmdList(all) {
  const ps = listProposals().filter((p) => all || p.status === 'pending-review' || p.status === 'error');
  if (!ps.length) { console.log('no proposals' + (all ? '' : ' pending review (use --all)')); return; }
  for (const p of ps) {
    const tag = p.status === 'error' ? C.r('ERROR') : p.status === 'pending-review' ? C.y('PENDING')
      : p.status === 'resolved' ? C.g('resolved') : p.status === 'replied' ? C.g('replied') : C.dim(p.status);
    const chg = p.needs_change ? C.b(`change[${p.risk}]`) : C.dim('reply-only');
    console.log(`${tag.padEnd(18)} ${C.b(p.id)}  ${chg}  ${C.dim('[' + (p.feedback && p.feedback.category) + ']')}`);
    console.log(`   ${(p.summary || p.error || '').slice(0, 100)}`);
    console.log(C.dim(`   "${String((p.feedback && p.feedback.text) || '').slice(0, 80).replace(/\n/g, ' ')}"`));
  }
  console.log(C.dim(`\n${ps.length} shown.  review:  node scripts/feedback-review.js show <id>`));
}

function cmdShow(id) {
  const p = find(id);
  console.log(C.b(`\n=== ${p.id}  (${p.status}) ===`));
  console.log(`when:    ${p.feedback.ts}`);
  console.log(`category:${p.feedback.category}`);
  console.log(`contact: ${p.feedback.contact || C.dim('(none)')}`);
  const imgs = Array.isArray(p.feedback.images) ? p.feedback.images
    : (p.feedback.image ? [p.feedback.image] : []);
  if (imgs.length) {
    console.log(`shots:   ${imgs.length} attached ${C.dim('(open to view)')}`);
    imgs.forEach((f) => console.log(`         data/feedback-images/${f}`));
  }
  console.log(`risk:    ${p.risk}   needs_change: ${p.needs_change}   cost: $${p.cost_usd || '?'}`);
  console.log(C.b('\n--- feedback ---')); console.log(p.feedback.text);
  if (p.error) { console.log(C.r('\n--- ERROR ---')); console.log(p.error); if (p.raw) console.log(C.dim(p.raw)); return; }
  console.log(C.b('\n--- summary ---')); console.log(p.summary || '(none)');
  console.log(C.b('\n--- draft reply ---')); console.log(p.reply || C.dim('(none)'));
  if (p.hasDiff) {
    console.log(C.b(`\n--- diff (${p.branch}) ---`));
    // prefer a live diff so it reflects current master
    const live = git(['diff', `master..${p.branch}`]);
    console.log(live.status === 0 && live.stdout ? live.stdout : (p.diff || '(diff unavailable)'));
  } else { console.log(C.dim('\n(no code change)')); }
  console.log(C.dim(`\napprove: node scripts/feedback-review.js approve ${p.id}`));
  console.log(C.dim(`reject:  node scripts/feedback-review.js reject ${p.id} [reason]`));
}

function ensureBranch(branch) {
  return git(['rev-parse', '--verify', branch]).status === 0;
}

function cmdApprove(id) {
  const p = find(id);
  if (p.status !== 'pending-review') console.log(C.y(`note: status is "${p.status}", proceeding anyway`));
  if (p.needs_change && p.hasDiff && p.branch) {
    if (!ensureBranch(p.branch)) { console.error(C.r(`branch ${p.branch} is gone; cannot merge`)); process.exit(1); }
    const cur = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
    if (cur !== 'master') { console.error(C.r(`repo is on "${cur}", expected master`)); process.exit(1); }
    const dirty = git(['status', '--porcelain']).stdout.trim();
    if (dirty) {
      console.error(C.r('working tree has uncommitted changes — commit or stash first, then re-run approve:'));
      console.error(dirty); process.exit(1);
    }
    const m = git(['merge', '--no-ff', p.branch, '-m', `merge ${p.branch}: ${p.summary || ''}`.slice(0, 120)]);
    if (m.status !== 0) { console.error(C.r('merge failed:\n') + m.stdout + m.stderr); process.exit(1); }
    console.log(C.g(`✓ merged ${p.branch} into master`));
    const touchedServer = /bridge\/server\.js/.test(p.diff || '');
    console.log(C.y('  → static files (UI/map/mission) are now LIVE on next page load.'));
    if (touchedServer) console.log(C.y('  → bridge/server.js changed: restart the bridge to apply (ask the user first).'));
    console.log(C.dim('  → not pushed. push manually when ready:  git push origin master'));
    p.status = 'resolved';
  } else {
    console.log(C.g('✓ accepted (reply-only, no code change)'));
    p.status = 'replied';
  }
  p.reviewed_at = new Date().toISOString();
  save(p);
  console.log(C.b('\n--- reply to send ---'));
  console.log(p.reply || C.dim('(none — write one)'));
  console.log(C.dim(`contact: ${p.feedback.contact || '(none provided)'}`));
}

function cmdReject(id, reason) {
  const p = find(id);
  if (p.branch && ensureBranch(p.branch)) {
    const d = git(['branch', '-D', p.branch]);
    console.log(d.status === 0 ? C.g(`✓ deleted branch ${p.branch}`) : C.y(`could not delete branch: ${d.stderr.trim()}`));
  }
  p.status = 'rejected';
  p.reject_reason = reason || '';
  p.reviewed_at = new Date().toISOString();
  save(p);
  console.log(C.g(`✓ ${id} rejected`) + (reason ? C.dim(` (${reason})`) : ''));
  if (p.feedback.contact) console.log(C.dim(`contact to notify: ${p.feedback.contact}`));
}

function cmdReply(id, text) {
  const p = find(id);
  if (text) p.reply = text;
  p.status = 'replied';
  p.reviewed_at = new Date().toISOString();
  save(p);
  console.log(C.g(`✓ ${id} marked replied`));
  console.log(C.b('\n--- reply ---')); console.log(p.reply || C.dim('(none)'));
  console.log(C.dim(`contact: ${p.feedback.contact || '(none)'}`));
}

function main() {
  const [cmd, id, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'list': return cmdList(rest.includes('--all') || id === '--all');
    case 'show': return cmdShow(id);
    case 'approve': return cmdApprove(id);
    case 'reject': return cmdReject(id, rest.join(' '));
    case 'reply': return cmdReply(id, rest.join(' '));
    default:
      console.log('usage: feedback-review.js <list|show|approve|reject|reply> [id] [args]');
      console.log('  list [--all] | show <id> | approve <id> | reject <id> [reason] | reply <id> [text]');
  }
}
main();
