'use strict';

/**
 * lib/db.js — SONARS SQLite Persistence Layer (better-sqlite3)
 * ──────────────────────────────────────────────────────────────
 * • WAL journal mode + foreign keys enabled
 * • Auto-creates parent directory for DB_PATH (e.g. /var/data on Render)
 * • Versioned, data-preserving SQLite migrations (schema_migrations + user_version)
 * • Multi-source deduplication via UNIQUE(source_type, source_entity_id)
 *   with nullable legacy Reddit columns (reddit_post_id, subreddit)
 */

const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'lead_monitor.db');
const CURRENT_SCHEMA_VERSION = 2;
const instances = new Map();

function resolveDbPath(customPath) {
  return customPath || process.env.DB_PATH || DEFAULT_DB_PATH;
}

function ensureDirForDb(dbPath) {
  if (!dbPath || dbPath === ':memory:') return;
  const dir = path.dirname(path.resolve(dbPath));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getDb(customPath) {
  const dbPath = resolveDbPath(customPath);
  if (instances.has(dbPath)) return instances.get(dbPath);

  ensureDirForDb(dbPath);
  const conn = new Database(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  initSchema(conn);
  instances.set(dbPath, conn);
  return conn;
}

function closeDb(customPath) {
  const dbPath = resolveDbPath(customPath);
  const conn = instances.get(dbPath);
  if (conn) {
    try { conn.close(); } catch {}
    instances.delete(dbPath);
  }
}

function ensureBaseTables(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS leads (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type          TEXT    NOT NULL DEFAULT 'reddit',
      source_entity_id     TEXT    NOT NULL,
      source_channel       TEXT    NOT NULL DEFAULT '',
      entity_name          TEXT,
      reddit_post_id       TEXT,
      subreddit            TEXT,
      title                TEXT    NOT NULL,
      content              TEXT,
      url                  TEXT    NOT NULL DEFAULT '',
      matched_keyword      TEXT    NOT NULL DEFAULT '',
      score                INTEGER NOT NULL DEFAULT 0,
      intent               TEXT    NOT NULL DEFAULT 'low',
      lead_value           INTEGER NOT NULL DEFAULT 50,
      status               TEXT    NOT NULL DEFAULT 'new',
      created_utc          INTEGER,
      ai_summary           TEXT,
      ai_score             INTEGER,
      ai_reply_suggestion  TEXT,
      raw_evidence         TEXT,
      intent_score         INTEGER NOT NULL DEFAULT 0,
      fit_score            INTEGER NOT NULL DEFAULT 50,
      confidence_score     INTEGER NOT NULL DEFAULT 50,
      opportunity_type     TEXT    NOT NULL DEFAULT 'unclassified',
      score_breakdown      TEXT,
      created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_type, source_entity_id)
    );

    CREATE TABLE IF NOT EXISTS outreach (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id        INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      message        TEXT,
      sent           INTEGER NOT NULL DEFAULT 0,
      reply_received INTEGER NOT NULL DEFAULT 0,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scan_stats (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle         INTEGER NOT NULL,
      source_type   TEXT    NOT NULL DEFAULT 'all',
      posts_checked INTEGER DEFAULT 0,
      matches_found INTEGER DEFAULT 0,
      dupes_skipped INTEGER DEFAULT 0,
      scan_ms       REAL    DEFAULT 0,
      alerts_sent   INTEGER DEFAULT 0,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function createIndexes(conn) {
  conn.exec(`
    CREATE INDEX IF NOT EXISTS idx_leads_intent       ON leads (intent);
    CREATE INDEX IF NOT EXISTS idx_leads_status       ON leads (status);
    CREATE INDEX IF NOT EXISTS idx_leads_score        ON leads (score DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_value        ON leads (lead_value DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_utc          ON leads (created_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_created      ON leads (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_source_type  ON leads (source_type);
    CREATE INDEX IF NOT EXISTS idx_leads_opportunity  ON leads (opportunity_type);
    CREATE INDEX IF NOT EXISTS idx_leads_fit          ON leads (fit_score DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_confidence   ON leads (confidence_score DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_source_entity
      ON leads (source_type, source_entity_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_reddit_post_id
      ON leads (reddit_post_id) WHERE reddit_post_id IS NOT NULL;
  `);
}

function runMigrationV1(conn) {
  const tx = conn.transaction(() => {
    const leadCols = conn.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
    const additions = [
      ['lead_value',          'INTEGER NOT NULL DEFAULT 50'],
      ['created_utc',         'INTEGER'],
      ['ai_summary',          'TEXT'],
      ['ai_score',            'INTEGER'],
      ['ai_reply_suggestion', 'TEXT'],
      ['source_type',         "TEXT NOT NULL DEFAULT 'reddit'"],
      ['source_entity_id',    'TEXT'],
      ['source_channel',      'TEXT'],
      ['entity_name',         'TEXT'],
      ['raw_evidence',        'TEXT'],
      ['intent_score',        'INTEGER NOT NULL DEFAULT 0'],
      ['fit_score',           'INTEGER NOT NULL DEFAULT 50'],
      ['confidence_score',    'INTEGER NOT NULL DEFAULT 50'],
      ['opportunity_type',    "TEXT NOT NULL DEFAULT 'unclassified'"],
      ['score_breakdown',     'TEXT'],
    ];

    for (const [col, def] of additions) {
      if (!leadCols.includes(col)) {
        conn.exec(`ALTER TABLE leads ADD COLUMN ${col} ${def}`);
      }
    }

    conn.exec(`
      UPDATE leads
         SET source_entity_id = COALESCE(NULLIF(source_entity_id, ''), reddit_post_id, CAST(id AS TEXT))
       WHERE source_entity_id IS NULL OR source_entity_id = '';

      UPDATE leads
         SET source_channel = COALESCE(NULLIF(source_channel, ''), subreddit, '')
       WHERE source_channel IS NULL;

      UPDATE leads
         SET intent_score = score
       WHERE intent_score = 0 AND score > 0;

      UPDATE leads
         SET fit_score = lead_value
       WHERE fit_score = 50 AND lead_value IS NOT NULL AND lead_value != 50;
    `);

    const statCols = conn.prepare('PRAGMA table_info(scan_stats)').all().map(c => c.name);
    if (!statCols.includes('source_type')) {
      conn.exec("ALTER TABLE scan_stats ADD COLUMN source_type TEXT NOT NULL DEFAULT 'all'");
    }

    conn.prepare(
      'INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)'
    ).run(1, 'v1_add_multisource_columns');
  });
  tx();
}

function needsV2TableRebuild(conn) {
  const cols = conn.prepare('PRAGMA table_info(leads)').all();
  const byName = new Map(cols.map(c => [c.name, c]));
  const redditCol = byName.get('reddit_post_id');
  const subCol    = byName.get('subreddit');
  const entityCol = byName.get('source_entity_id');
  return Boolean(
    (redditCol && redditCol.notnull === 1) ||
    (subCol && subCol.notnull === 1) ||
    (entityCol && entityCol.notnull === 0)
  );
}

function runMigrationV2(conn) {
  if (!needsV2TableRebuild(conn)) {
    conn.prepare(
      'INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)'
    ).run(2, 'v2_generalize_leads_constraints');
    return;
  }

  const existingCols = new Set(conn.prepare('PRAGMA table_info(leads)').all().map(c => c.name));
  const opt = (col) => (existingCols.has(col) ? col : `NULL AS ${col}`);

  // Standard SQLite table-rebuild procedure preserving all leads & outreach FKs
  conn.pragma('foreign_keys = OFF');
  try {
    const tx = conn.transaction(() => {
      conn.exec(`
        CREATE TABLE leads_v2 (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          source_type          TEXT    NOT NULL DEFAULT 'reddit',
          source_entity_id     TEXT    NOT NULL,
          source_channel       TEXT    NOT NULL DEFAULT '',
          entity_name          TEXT,
          reddit_post_id       TEXT,
          subreddit            TEXT,
          title                TEXT    NOT NULL,
          content              TEXT,
          url                  TEXT    NOT NULL DEFAULT '',
          matched_keyword      TEXT    NOT NULL DEFAULT '',
          score                INTEGER NOT NULL DEFAULT 0,
          intent               TEXT    NOT NULL DEFAULT 'low',
          lead_value           INTEGER NOT NULL DEFAULT 50,
          status               TEXT    NOT NULL DEFAULT 'new',
          created_utc          INTEGER,
          ai_summary           TEXT,
          ai_score             INTEGER,
          ai_reply_suggestion  TEXT,
          raw_evidence         TEXT,
          intent_score         INTEGER NOT NULL DEFAULT 0,
          fit_score            INTEGER NOT NULL DEFAULT 50,
          confidence_score     INTEGER NOT NULL DEFAULT 50,
          opportunity_type     TEXT    NOT NULL DEFAULT 'unclassified',
          score_breakdown      TEXT,
          created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(source_type, source_entity_id)
        );

        INSERT INTO leads_v2 (
          id, source_type, source_entity_id, source_channel, entity_name,
          reddit_post_id, subreddit, title, content, url, matched_keyword,
          score, intent, lead_value, status, created_utc,
          ai_summary, ai_score, ai_reply_suggestion, raw_evidence,
          intent_score, fit_score, confidence_score, opportunity_type,
          score_breakdown, created_at
        )
        SELECT
          id,
          COALESCE(NULLIF(source_type, ''), 'reddit'),
          COALESCE(NULLIF(source_entity_id, ''), reddit_post_id, CAST(id AS TEXT)),
          COALESCE(source_channel, subreddit, ''),
          ${opt('entity_name')},
          reddit_post_id,
          subreddit,
          title,
          ${opt('content')},
          COALESCE(${opt('url')}, ''),
          COALESCE(${opt('matched_keyword')}, ''),
          COALESCE(${opt('score')}, ${opt('intent_score')}, 0),
          COALESCE(NULLIF(${opt('intent')}, ''), 'low'),
          COALESCE(${opt('lead_value')}, ${opt('fit_score')}, 50),
          COALESCE(NULLIF(${opt('status')}, ''), 'new'),
          ${opt('created_utc')},
          ${opt('ai_summary')},
          ${opt('ai_score')},
          ${opt('ai_reply_suggestion')},
          ${opt('raw_evidence')},
          COALESCE(${opt('intent_score')}, ${opt('score')}, 0),
          COALESCE(${opt('fit_score')}, ${opt('lead_value')}, 50),
          COALESCE(${opt('confidence_score')}, 50),
          COALESCE(NULLIF(${opt('opportunity_type')}, ''), 'unclassified'),
          ${opt('score_breakdown')},
          ${opt('created_at')}
        FROM leads;

        DROP TABLE leads;
        ALTER TABLE leads_v2 RENAME TO leads;
      `);

      conn.prepare(
        'INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)'
      ).run(2, 'v2_generalize_leads_constraints');
    });
    tx();

    const fkIssues = conn.pragma('foreign_key_check');
    if (Array.isArray(fkIssues) && fkIssues.length > 0) {
      throw new Error(`Foreign key integrity check failed after v2 migration: ${JSON.stringify(fkIssues)}`);
    }
  } finally {
    conn.pragma('foreign_keys = ON');
  }
}

function initSchema(conn) {
  ensureBaseTables(conn);

  const applied = new Set(
    conn.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
  );

  if (!applied.has(1)) {
    runMigrationV1(conn);
  }
  if (!applied.has(2) || needsV2TableRebuild(conn)) {
    runMigrationV2(conn);
  }

  createIndexes(conn);
  conn.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
}

function getSchemaVersion(dbPath) {
  const conn = getDb(dbPath);
  const rows = conn.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC').all();
  const userVersion = conn.pragma('user_version', { simple: true });
  return { userVersion, migrations: rows };
}

function normalizeRow(row) {
  if (!row) return null;
  const plain = { ...row };
  try {
    plain.score_breakdown_parsed = plain.score_breakdown ? JSON.parse(plain.score_breakdown) : null;
  } catch {
    plain.score_breakdown_parsed = null;
  }
  try {
    plain.raw_evidence_parsed = plain.raw_evidence ? JSON.parse(plain.raw_evidence) : null;
  } catch {
    plain.raw_evidence_parsed = null;
  }
  return plain;
}

function insertLead(data, dbPath) {
  const conn = getDb(dbPath);
  const sourceType = data.source_type || 'reddit';
  const sourceEntityId = data.source_entity_id || data.reddit_post_id || '';
  if (!sourceEntityId) return null;

  const sourceChannel   = data.source_channel != null ? data.source_channel : (data.subreddit || '');
  const isReddit        = sourceType === 'reddit';
  const redditPostId    = data.reddit_post_id !== undefined
    ? data.reddit_post_id
    : (isReddit ? sourceEntityId : null);
  const subreddit       = data.subreddit !== undefined
    ? data.subreddit
    : (isReddit ? sourceChannel : null);

  const intentScore     = Number(data.intent_score != null ? data.intent_score : (data.score || 0));
  const leadValue       = Number(data.lead_value != null ? data.lead_value : (data.fit_score != null ? data.fit_score : 50));
  const fitScore        = Number(data.fit_score != null ? data.fit_score : leadValue);
  const confidenceScore = Number(data.confidence_score != null ? data.confidence_score : 50);

  const rawEvidence = data.raw_evidence == null
    ? null
    : (typeof data.raw_evidence === 'string' ? data.raw_evidence : JSON.stringify(data.raw_evidence));

  const scoreBreakdown = data.score_breakdown == null
    ? null
    : (typeof data.score_breakdown === 'string' ? data.score_breakdown : JSON.stringify(data.score_breakdown));

  const stmt = conn.prepare(`
    INSERT OR IGNORE INTO leads (
      source_type, source_entity_id, source_channel, entity_name,
      reddit_post_id, subreddit, title, content, url, matched_keyword,
      score, intent, lead_value, status, created_utc, raw_evidence,
      intent_score, fit_score, confidence_score, opportunity_type, score_breakdown
    ) VALUES (
      @source_type, @source_entity_id, @source_channel, @entity_name,
      @reddit_post_id, @subreddit, @title, @content, @url, @matched_keyword,
      @score, @intent, @lead_value, @status, @created_utc, @raw_evidence,
      @intent_score, @fit_score, @confidence_score, @opportunity_type, @score_breakdown
    )
  `);

  const result = stmt.run({
    source_type:      sourceType,
    source_entity_id: sourceEntityId,
    source_channel:   sourceChannel,
    entity_name:      data.entity_name || null,
    reddit_post_id:   redditPostId,
    subreddit,
    title:            data.title || '',
    content:          data.content || null,
    url:              data.url || '',
    matched_keyword:  data.matched_keyword || '',
    score:            intentScore,
    intent:           data.intent || 'low',
    lead_value:       leadValue,
    status:           data.status || 'new',
    created_utc:      data.created_utc ? Number(data.created_utc) : null,
    raw_evidence:     rawEvidence,
    intent_score:     intentScore,
    fit_score:        fitScore,
    confidence_score: confidenceScore,
    opportunity_type: data.opportunity_type || 'unclassified',
    score_breakdown:  scoreBreakdown,
  });

  if (result.changes === 0) return null;
  const row = conn.prepare('SELECT * FROM leads WHERE rowid = ?').get(result.lastInsertRowid);
  return normalizeRow(row);
}

function getLeads({ intent, source, opportunity, status, q, sort = 'created_at', limit = 300 } = {}, dbPath) {
  const conn = getDb(dbPath);
  const ORDER = {
    score:      'intent_score DESC, lead_value DESC, created_at DESC',
    value:      'lead_value DESC, intent_score DESC, created_at DESC',
    fit:        'fit_score DESC, intent_score DESC, created_at DESC',
    confidence: 'confidence_score DESC, intent_score DESC, created_at DESC',
    composite:  '(intent_score + fit_score + confidence_score) DESC, created_at DESC',
    created_at: 'created_utc DESC, created_at DESC, id DESC',
  };
  const order = ORDER[sort] || ORDER.created_at;

  const where  = [];
  const params = [];

  if (intent && ['high', 'medium', 'low'].includes(intent)) {
    where.push('intent = ?');
    params.push(intent);
  }
  if (source && source !== 'all') {
    where.push('source_type = ?');
    params.push(source);
  }
  if (opportunity && opportunity !== 'all') {
    where.push('opportunity_type = ?');
    params.push(opportunity);
  }
  if (status && ['new', 'contacted', 'ignored', 'won'].includes(status)) {
    where.push('status = ?');
    params.push(status);
  }
  if (q && String(q).trim()) {
    const like = `%${String(q).trim()}%`;
    where.push('(title LIKE ? OR content LIKE ? OR matched_keyword LIKE ? OR source_channel LIKE ? OR entity_name LIKE ?)');
    params.push(like, like, like, like, like);
  }

  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 300));
  const sql = `SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ?`;
  params.push(safeLimit);

  return conn.prepare(sql).all(...params).map(normalizeRow);
}

function getLeadById(id, dbPath) {
  const conn = getDb(dbPath);
  return normalizeRow(conn.prepare('SELECT * FROM leads WHERE id = ?').get(id));
}

function updateLeadStatus(id, status, dbPath) {
  const conn = getDb(dbPath);
  return conn.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, id);
}

function getSeenIds(sourceType, dbPath) {
  const conn = getDb(dbPath);
  if (sourceType) {
    return conn
      .prepare('SELECT COALESCE(source_entity_id, reddit_post_id) AS sid FROM leads WHERE source_type = ?')
      .all(sourceType)
      .map(r => r.sid)
      .filter(Boolean);
  }
  return conn
    .prepare('SELECT COALESCE(source_entity_id, reddit_post_id) AS sid FROM leads')
    .all()
    .map(r => r.sid)
    .filter(Boolean);
}

function getDbStats(dbPath) {
  const conn = getDb(dbPath);
  const total    = conn.prepare('SELECT COUNT(*) AS n FROM leads').get().n;
  const high     = conn.prepare("SELECT COUNT(*) AS n FROM leads WHERE intent='high'").get().n;
  const medium   = conn.prepare("SELECT COUNT(*) AS n FROM leads WHERE intent='medium'").get().n;
  const active   = conn.prepare("SELECT COUNT(*) AS n FROM leads WHERE opportunity_type='active_buying_intent'").get().n;
  const avgScore = conn.prepare('SELECT ROUND(AVG(intent_score),0) AS a FROM leads').get().a || 0;
  const avgVal   = conn.prepare('SELECT ROUND(AVG(lead_value),0) AS a FROM leads').get().a || 0;
  const newest   = conn.prepare('SELECT created_at FROM leads ORDER BY created_at DESC LIMIT 1').get();
  const dupeRow  = conn.prepare('SELECT SUM(dupes_skipped) AS d FROM scan_stats').get();

  return {
    total,
    high,
    medium,
    active_buying_intent: active,
    avg_score:   Number(avgScore),
    avg_value:   Number(avgVal),
    newest_at:   newest ? newest.created_at : null,
    total_dupes: Number(dupeRow.d || 0),
  };
}

function recordScanStat(data, dbPath) {
  const conn = getDb(dbPath);
  conn.prepare(`
    INSERT INTO scan_stats
      (cycle, source_type, posts_checked, matches_found, dupes_skipped, scan_ms, alerts_sent)
    VALUES
      (@cycle, @source_type, @posts_checked, @matches_found, @dupes_skipped, @scan_ms, @alerts_sent)
  `).run({
    cycle:         Number(data.cycle || 0),
    source_type:   data.source_type || 'all',
    posts_checked: Number(data.posts_checked || 0),
    matches_found: Number(data.matches_found || 0),
    dupes_skipped: Number(data.dupes_skipped || 0),
    scan_ms:       Number(data.scan_ms || 0),
    alerts_sent:   Number(data.alerts_sent || 0),
  });
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  getDb,
  closeDb,
  getSchemaVersion,
  insertLead,
  getLeads,
  getLeadById,
  updateLeadStatus,
  getSeenIds,
  getDbStats,
  recordScanStat,
};
