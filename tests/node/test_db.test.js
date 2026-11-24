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
    assert.equal(schemaInfo.userVersion, 3);
    assert.deepEqual(schemaInfo.migrations.map(m => m.version), [1, 2, 3]);

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
    assert.equal(schemaInfo.userVersion, 3);
    assert.deepEqual(schemaInfo.migrations.map(m => m.version), [1, 2, 3]);

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

test('db v3 migration rolls back atomically on pre-commit foreign_key_check failure', () => {
  const tmpDir = makeTempDir();
  const dbPath = path.join(tmpDir, 'fk_rollback.db');

  try {
    const conn = new Database(dbPath);
    conn.pragma('foreign_keys = ON');
    conn.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL DEFAULT 'reddit',
        source_entity_id TEXT NOT NULL,
        source_channel TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        UNIQUE(source_type, source_entity_id)
      );
      INSERT INTO schema_migrations (version, name) VALUES (1, 'v1'), (2, 'v2');
    `);

    assert.throws(() => {
      db.runMigrationV3(conn, {
        checkFkFn: () => [{ table: 'outreach', rowid: 1, parent: 'leads', fkid: 0 }],
      });
    }, /Foreign key integrity check failed/);

    // Verify migration v3 & added columns were completely rolled back
    const cols = conn.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
    assert.ok(!cols.includes('observation_type'));
    assert.ok(!cols.includes('suppressed'));
    const v3 = conn.prepare('SELECT version FROM schema_migrations WHERE version = 3').get();
    assert.equal(v3, undefined);
    conn.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('db enforces POPIA review guardrails, suppression block on re-ingest, and retention purge', () => {
  const tmpDir = makeTempDir();
  const dbPath = path.join(tmpDir, 'popia.db');

  try {
    const entity = db.insertLead({
      source_type: 'osm',
      source_entity_id: 'node/777001',
      source_channel: 'osm:Cape Town',
      entity_name: 'Harbour Books',
      title: 'Harbour Books — shop:books (no website listed)',
      observation_type: 'digital_presence_gap',
      opportunity_type: 'digital_need',
      intent_score: 0,
      intent: 'low',
      fit_score: 62,
      confidence_score: 80,
      contact_eligible: 1, // Should be forced to 0 until human review_status='approved'
      retention_until: 1000,
    }, dbPath);

    assert.ok(entity);
    assert.equal(entity.review_status, 'pending_review');
    assert.equal(entity.contact_eligible, 0);

    // Approving allows setting contact_eligible for non-personal business entity
    const approved = db.updateLeadReview(entity.id, {
      review_status: 'approved',
      contact_eligible: true,
      review_notes: 'Verified independent bookstore without website.',
    }, dbPath);
    assert.equal(approved.signal.review_status, 'approved');
    assert.equal(approved.signal.contact_eligible, 1);

    // Suppressing forces contact_eligible=0 and adds to suppression_list
    const suppressed = db.updateLeadReview(entity.id, {
      suppressed: true,
      review_notes: 'Do not contact requested.',
    }, dbPath);
    assert.equal(suppressed.signal.suppressed, 1);
    assert.equal(suppressed.signal.contact_eligible, 0);
    assert.equal(suppressed.signal.review_status, 'suppressed');
    assert.equal(db.getSuppressionList(dbPath).length, 1);

    // Attempting to re-insert a suppressed entity is blocked atomically
    const reInserted = db.insertLead({
      source_type: 'osm',
      source_entity_id: 'node/777001',
      title: 'Harbour Books (re-discovered)',
    }, dbPath);
    assert.equal(reInserted, null);

    // Expired unapproved entity gets purged, while approved, active, and unexpired records are retained
    const expired = db.insertLead({
      source_type: 'cipc',
      source_entity_id: '2019/000111/07',
      title: 'Expired Unapproved Entity',
      observation_type: 'entity_verified',
      retention_until: 500,
    }, dbPath);
    assert.ok(expired);

    const approvedKeep = db.insertLead({
      source_type: 'osm',
      source_entity_id: 'node/888001',
      title: 'Approved Entity Kept',
      observation_type: 'digital_presence_gap',
      review_status: 'approved',
      retention_until: 500,
    }, dbPath);
    assert.ok(approvedKeep);

    const redditActive = db.insertLead({
      source_type: 'reddit',
      source_entity_id: 'https://www.reddit.com/r/forhire/comments/active1/test',
      source_channel: 'r/forhire',
      title: 'Active Contacted Buying Intent',
      observation_type: 'buying_intent_signal',
      intent_score: 80,
      intent: 'high',
      status: 'contacted',
      retention_until: 500,
    }, dbPath);
    assert.ok(redditActive);

    const personalRecord = db.insertLead({
      source_type: 'cipc',
      source_entity_id: '2022/999888/07',
      title: 'Director PII Test',
      observation_type: 'entity_verified',
      is_personal_info: 1,
      retention_until: 99999,
    }, dbPath);
    assert.ok(personalRecord);

    // Personal info cannot be marked contact_eligible even when approved
    const piiDenied = db.updateLeadReview(personalRecord.id, {
      review_status: 'approved',
      contact_eligible: true,
    }, dbPath);
    assert.equal(piiDenied.code, 400);

    // Suppressed entity cannot be promoted to contact_eligible without explicit unsuppress
    const supPromoDenied = db.updateLeadReview(entity.id, {
      review_status: 'approved',
      contact_eligible: true,
    }, dbPath);
    assert.equal(supPromoDenied.code, 400);

    const purgeRes = db.purgeExpiredRecords(2000, dbPath);
    assert.equal(purgeRes.deleted, 2); // suppressed entity (retention=1000) + unapproved entity (retention=500)
    assert.equal(db.getLeadById(expired.id, dbPath), null);
    assert.ok(db.getLeadById(approvedKeep.id, dbPath));
    assert.ok(db.getLeadById(redditActive.id, dbPath));
    assert.ok(db.getLeadById(personalRecord.id, dbPath));

    // Even after retention purge removed the lead row, suppression_list still blocks re-ingest
    const blockedAfterPurge = db.insertLead({
      source_type: 'osm',
      source_entity_id: 'node/777001',
      title: 'Harbour Books Re-Discovered Post-Purge',
    }, dbPath);
    assert.equal(blockedAfterPurge, null);

    // Verify record_kind separation and separated stats
    const buyingOnly = db.getLeads({ record_kind: 'buying_intent' }, dbPath);
    assert.equal(buyingOnly.length, 1);
    assert.equal(buyingOnly[0].record_kind, 'buying_intent');

    const discoveryOnly = db.getLeads({ record_kind: 'entity_discovery' }, dbPath);
    assert.equal(discoveryOnly.length, 2);
    assert.ok(discoveryOnly.every(r => r.record_kind === 'entity_discovery'));

    const stats = db.getDbStats(dbPath);
    assert.equal(stats.buying_intent_total, 1);
    assert.equal(stats.entity_discovery_total, 2);
    assert.equal(stats.avg_score, 80); // Not diluted by 0-intent discovery records
  } finally {
    db.closeDb(dbPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
