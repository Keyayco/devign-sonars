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

test('db auto-creates nested DB_PATH, runs versioned v2 generalized schema, supports non-Reddit sources, and persists across restarts', () => {
  const tmpDir = makeTempDir();
  const dbPath = path.join(tmpDir, 'nested', 'var', 'data', 'lead_monitor.db');

  try {
    const conn = db.getDb(dbPath);
    const mode = conn.pragma('journal_mode', { simple: true });
    assert.equal(mode, 'wal');

    const schemaInfo = db.getSchemaVersion(dbPath);
    assert.equal(schemaInfo.userVersion, 2);
    assert.deepEqual(schemaInfo.migrations.map(m => m.version), [1, 2]);

    // Insert Reddit signal
    const redditLead = db.insertLead({
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

    assert.ok(redditLead);
    assert.equal(redditLead.reddit_post_id, 'https://www.reddit.com/r/forhire/comments/101/test');
    assert.equal(redditLead.subreddit, 'r/forhire');

    // Insert generic non-Reddit signal with null reddit_post_id and subreddit
    const genericLead = db.insertLead({
      source_type:      'directory',
      source_entity_id: 'acme-digital-2026-001',
      source_channel:   'za-business-registry',
      entity_name:      'Acme Digital Pty Ltd',
      title:            'Acme Digital Pty Ltd — no website detected',
      content:          'Commercial consulting entity lacking verified domain presence.',
      url:              'https://example.com/directory/acme-digital',
      matched_keyword:  'consulting',
      intent_score:     25,
      intent:           'low',
      lead_value:       68,
      confidence_score: 85,
      opportunity_type: 'digital_need',
    }, dbPath);

    assert.ok(genericLead);
    assert.equal(genericLead.source_type, 'directory');
    assert.equal(genericLead.reddit_post_id, null);
    assert.equal(genericLead.subreddit, null);

    // Duplicate insertion ignored atomically per (source_type, source_entity_id)
    const dupe = db.insertLead({
      source_type:      'directory',
      source_entity_id: 'acme-digital-2026-001',
      source_channel:   'za-business-registry',
      title:            'Duplicate entity',
    }, dbPath);
    assert.equal(dupe, null);

    // Update status and verify restart persistence
    const upd = db.updateLeadStatus(redditLead.id, 'contacted', dbPath);
    assert.equal(upd.changes, 1);

    db.closeDb(dbPath);

    const leads = db.getLeads({ q: 'founder', intent: 'high' }, dbPath);
    assert.equal(leads.length, 1);
    assert.equal(leads[0].status, 'contacted');
    assert.equal(db.getSeenIds('reddit', dbPath).length, 1);
    assert.equal(db.getSeenIds(undefined, dbPath).length, 2);
  } finally {
    db.closeDb(dbPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('db upgrades legacy NOT NULL Reddit schema to generalized v2 without losing leads or outreach FKs', () => {
  const tmpDir = makeTempDir();
  const dbPath = path.join(tmpDir, 'legacy.db');

  try {
    const legacy = new Database(dbPath);
    legacy.pragma('foreign_keys = ON');
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
      CREATE TABLE outreach (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        message TEXT,
        sent INTEGER NOT NULL DEFAULT 0,
        reply_received INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO leads (id, reddit_post_id, subreddit, title, content, url, matched_keyword, score, intent, status)
      VALUES (42, 'https://www.reddit.com/r/entrepreneur/comments/legacy1', 'r/entrepreneur', 'Legacy Hire', 'Budget ready', 'https://www.reddit.com/r/entrepreneur/comments/legacy1', 'hire', 72, 'high', 'won');
      INSERT INTO outreach (lead_id, message, sent)
      VALUES (42, 'Hello from Devign Digital', 1);
    `);
    legacy.close();

    const conn = db.getDb(dbPath);
    const schemaInfo = db.getSchemaVersion(dbPath);
    assert.equal(schemaInfo.userVersion, 2);
    assert.deepEqual(schemaInfo.migrations.map(m => m.version), [1, 2]);

    // Verify reddit_post_id and subreddit are now nullable
    const cols = new Map(conn.prepare('PRAGMA table_info(leads)').all().map(c => [c.name, c]));
    assert.equal(cols.get('reddit_post_id').notnull, 0);
    assert.equal(cols.get('subreddit').notnull, 0);
    assert.equal(cols.get('source_entity_id').notnull, 1);

    // Existing row & outreach FK preserved with original ID
    const migrated = db.getLeadById(42, dbPath);
    assert.ok(migrated);
    assert.equal(migrated.source_entity_id, 'https://www.reddit.com/r/entrepreneur/comments/legacy1');
    assert.equal(migrated.intent_score, 72);
    assert.equal(migrated.status, 'won');

    const outreachRow = conn.prepare('SELECT * FROM outreach WHERE lead_id = 42').get();
    assert.ok(outreachRow);
    assert.equal(outreachRow.message, 'Hello from Devign Digital');

    // Non-Reddit signal can now be inserted into the upgraded DB
    const nonReddit = db.insertLead({
      source_type:      'custom_source',
      source_entity_id: 'custom-99',
      source_channel:   'partner-feed',
      title:            'Custom Non-Reddit Prospect',
      intent_score:     60,
      intent:           'medium',
    }, dbPath);
    assert.ok(nonReddit);
    assert.equal(nonReddit.reddit_post_id, null);
    assert.equal(nonReddit.subreddit, null);
  } finally {
    db.closeDb(dbPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
