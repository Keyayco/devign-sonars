/**
 * frontend/components/config-view.js — SONARS Worker & Alert Configuration View
 */

export function createConfigView(rootEl, { onSave }) {
  rootEl.innerHTML = `
    <div class="card-head">
      <span>Monitor & Alert Configuration</span>
      <span class="meta-text">Changes apply on next worker start</span>
    </div>
    <form id="config-form" class="form-grid">
      <div class="field">
        <label class="field-label" for="cfg-token">
          <span>Telegram Bot Token</span>
          <span id="token-status" class="cfg-no">Not configured</span>
        </label>
        <input
          type="password"
          id="cfg-token"
          autocomplete="off"
          placeholder="Leave blank to keep existing token"
        />
        <span class="field-hint">Production recommendation: inject via TELEGRAM_BOT_TOKEN env var.</span>
      </div>

      <div class="field">
        <label class="field-label" for="cfg-chatid">
          <span>Telegram Chat ID</span>
          <span id="chatid-status" class="cfg-no">Not configured</span>
        </label>
        <input
          type="text"
          id="cfg-chatid"
          autocomplete="off"
          placeholder="Leave blank to keep existing chat ID"
        />
        <span class="field-hint">Only medium and high intent signals dispatch Telegram alerts.</span>
      </div>

      <div class="field">
        <label class="field-label" for="cfg-interval">Poll Interval (seconds)</label>
        <input type="number" id="cfg-interval" min="30" max="86400" step="1" required />
        <span class="field-hint">Minimum 30s. Reddit rate-limits trigger automatic exponential backoff.</span>
      </div>

      <div class="field full">
        <label class="field-label" for="cfg-feeds">Reddit RSS Feed URLs (one HTTPS URL per line)</label>
        <textarea id="cfg-feeds" rows="6" spellcheck="false"></textarea>
      </div>

      <div class="field full">
        <label class="field-label" for="cfg-keywords">Intent Keywords (one phrase per line)</label>
        <textarea id="cfg-keywords" rows="7" spellcheck="false"></textarea>
      </div>

      <div class="field full">
        <div class="save-row">
          <button type="submit" class="btn btn-primary" id="btn-save-config">Save Configuration</button>
          <span id="cfg-save-msg" class="save-msg" hidden>Configuration saved.</span>
        </div>
      </div>
    </form>
  `;

  const form        = rootEl.querySelector('#config-form');
  const tokenEl     = rootEl.querySelector('#cfg-token');
  const chatEl      = rootEl.querySelector('#cfg-chatid');
  const tokenStatEl = rootEl.querySelector('#token-status');
  const chatStatEl  = rootEl.querySelector('#chatid-status');
  const intervalEl  = rootEl.querySelector('#cfg-interval');
  const feedsEl     = rootEl.querySelector('#cfg-feeds');
  const keywordsEl  = rootEl.querySelector('#cfg-keywords');
  const saveMsgEl   = rootEl.querySelector('#cfg-save-msg');
  const saveBtn     = rootEl.querySelector('#btn-save-config');

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const interval = parseInt(intervalEl.value, 10);
    if (!Number.isFinite(interval) || interval < 30 || interval > 86400) {
      onSave?.({ error: 'Interval must be between 30 and 86400 seconds.' });
      return;
    }

    const payload = {
      interval,
      feeds:    feedsEl.value.split('\n').map(s => s.trim()).filter(Boolean),
      keywords: keywordsEl.value.split('\n').map(s => s.trim()).filter(Boolean),
    };
    if (tokenEl.value.trim()) payload.bot_token = tokenEl.value.trim();
    if (chatEl.value.trim())  payload.chat_id   = chatEl.value.trim();

    saveBtn.disabled = true;
    try {
      await onSave?.({ payload });
      tokenEl.value = '';
      chatEl.value  = '';
      saveMsgEl.hidden = false;
      setTimeout(() => { saveMsgEl.hidden = true; }, 2500);
    } finally {
      saveBtn.disabled = false;
    }
  });

  function setConfig(cfg) {
    if (!cfg) return;
    if (cfg.token_from_env) {
      tokenStatEl.textContent = 'Set via env var';
      tokenStatEl.className = 'cfg-yes';
    } else if (cfg.token_configured) {
      tokenStatEl.textContent = 'Configured';
      tokenStatEl.className = 'cfg-yes';
    } else {
      tokenStatEl.textContent = 'Not configured';
      tokenStatEl.className = 'cfg-no';
    }

    if (cfg.chat_id_from_env) {
      chatStatEl.textContent = 'Set via env var';
      chatStatEl.className = 'cfg-yes';
    } else if (cfg.chat_id_configured) {
      chatStatEl.textContent = `Configured (${cfg.chat_id_display || 'masked'})`;
      chatStatEl.className = 'cfg-yes';
    } else {
      chatStatEl.textContent = 'Not configured';
      chatStatEl.className = 'cfg-no';
    }

    intervalEl.value = cfg.interval || 120;
    feedsEl.value    = (cfg.feeds || []).join('\n');
    keywordsEl.value = (cfg.keywords || []).join('\n');
  }

  return { setConfig };
}
