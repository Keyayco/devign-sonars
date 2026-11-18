'use strict';

const test     = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');
const Database = require('better-sqlite3');

const db = require('../../lib/db');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sonars-db-'));
}

test('db auto-creates nested DB_PATH directory, uses WAL, deduplicates, and persists across restarts', () => {
  const tmpDir = makeTempDir();
  const dbPath = path.join(tmpDir, 'nested', 'var', 'data', 'lead_monitor.db');

  try {
    const conn = db.getDb(dbPath);
    const mode = conn.pragma('journal_mode', { simple: true });
    assert.equal(mode, 'wal');

    const inserted = db.insertLead({
      source_type:      'reddit',
      source_entity_id: 'https://www.reddit.com/r/forhire/comments/101/test',
      source_channel:   'r/forhire',
      entity_name:      'u/founder',
      title:            'Need a website ASAP',
      content:          'Looking to hire a developer with budget ready.',
      url:              'https://www.reddit.com/r/forhire/comments/101/test',
      matched_keyword:  'need a website',
      intent_score:     78,
      intent:           'high',
      lead_value:       82,
      confidence_score: 79,
      opportunity_type: 'active_buying_intent',
      score_breakdown:  { intent_factors: ['+38 "need a developer"'] },
      created_utc:      1760000000,
    }, dbPath);

    assert.ok(inserted);
    assert.equal(inserted.intent, 'high');
    assert.deepEqual(inserted.score_breakdown_parsed, { intent_factors: ['+38 "need a developer"'] });

    // Duplicate insertion ignored atomically
    const dupe = db.insertLead({
      source_type:      'reddit',
      source_entity_id: 'https://www.reddit.com/r/forhire/comments/101/test',
      source_channel:   'r/forhire',
      title:            'Duplicate title',
      url:              'https://www.reddit.com/r/forhire/comments/101/test',
      matched_keyword:  'need a website',
    }, dbPath);
    assert.equal(dupe, null);

    // Update status
    const upd = db.updateLeadStatus(inserted.id, 'contacted', dbPath);
    assert.equal(upd.changes, 1);

    // Simulate process restart by closing DB handle and reopening
    db.closeDb(dbPath);

    const leads = db.getLeads({ q: 'founder', intent: 'high' }, dbPath);
    assert.equal(leads.length, 1);
    assert.equal(leads[0].status, 'contacted');
    assert.equal(db.getSeenIds('reddit', dbPath).length, 1);

    const stats = db.getDbStats(dbPath);
    assert.equal(stats.total, 1);
    assert.equal(stats.high, 1);
  } finally {
    db.closeDb(dbPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('db migrates legacy leads schema without losing existing rows', () => {
  const tmpDir = makeTempDir();
  const dbPath = path.join(tmpDir, 'legacy.db');

  try {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reddit_post_id TEXT UNIQUE NOT NULL,
        subreddit TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT,
        url TEXT NOT NULL,
        matched_keyword TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        intent TEXT NOT NULL DEFAULT 'low',
        status TEXT NOT NULL DEFAULT 'new',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO leads (reddit_post_id, subreddit, title, content, url, matched_keyword, score, intent, status)
      VALUES ('https://www.reddit.com/r/entrepreneur/comments/legacy1', 'r/entrepreneur', 'Legacy Hire', 'Budget ready', 'https://www.reddit.com/r/entrepreneur/comments/legacy1', 'hire', 72, 'high', 'won');
    `);
    legacy.close();

    const conn = db.getDb(dbPath);
    const cols = conn.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
    for (const expected of ['lead_value', 'source_type', 'source_entity_id', 'confidence_score', 'opportunity_type', 'score_breakdown']) {
      assert.ok(cols.includes(expected), `Missing migrated column ${expected}`);
    }

    const migrated = db.getLeads({}, dbPath);
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].source_entity_id, 'https://www.reddit.com/r/entrepreneur/comments/legacy1');
    assert.equal(migrated[0].intent_score, 72);
    assert.equal(migrated[0].status, 'won');
  } finally {
    db.closeDb(dbPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
