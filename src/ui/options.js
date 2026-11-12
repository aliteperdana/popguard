'use strict';

const el = (id) => document.getElementById(id);

const REASONS = {
  'no-activation': 'no user interaction',
  keyboard: 'triggered by keyboard',
  'untrusted-event': 'untrusted event',
  'hidden-anchor': 'invisible link',
  'cross-domain': 'cross-domain target',
  'cross-domain-anchor': 'cross-domain link',
  'cross-domain-tab': 'cross-domain tab closed',
  'cross-domain-popup': 'cross-domain popup closed',
  'cross-domain-redirect': 'tab switched domains',
  'late-popup': 'blank popup filled late',
};

const VERDICTS = {
  'blocked-cross-domain': 'BLOCKED — cross-domain',
  'blocked-orphan-popup': 'BLOCKED — popup without opener',
  'blocked-redirect': 'BLOCKED — cross-domain hop',
  'blocked-late-popup': 'BLOCKED — blank popup filled late',
  'allowed-context-menu': 'allowed — right-click menu',
  'allowed-manual-navigation': 'allowed — opened manually',
  'allowed-by-page-guard': 'allowed — page guard',
  'same-site': 'allowed — same site',
  'protected-host': 'allowed — other protected site',
  exception: 'allowed — exception',
  'no-protected-opener': 'ignored — no protected opener',
  'skipped-same-window': 'ignored — same-window tab',
  'skip-empty-url': 'ignored — empty URL',
};

function showMessage(text) {
  const node = el('message');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => {
    node.hidden = true;
  }, 4000);
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: 'thg:state' });
  return response && response.ok
    ? {
        hosts: response.hosts || {},
        log: response.log || [],
        exceptions: response.exceptions || [],
        diag: response.diag || [],
        seen: response.seen || {},
      }
    : { hosts: {}, log: [], exceptions: [], diag: [], seen: {} };
}

function renderHosts(hosts, seen) {
  const body = el('hosts');
  body.textContent = '';
  const entries = Object.values(hosts);
  el('hosts-empty').hidden = entries.length > 0;

  for (const entry of entries.sort((a, b) => a.host.localeCompare(b.host))) {
    const row = document.createElement('tr');

    const host = document.createElement('td');
    host.className = 'mono nowrap';
    host.textContent = entry.host;

    const mode = document.createElement('td');
    const select = document.createElement('select');
    select.className = 'input';
    for (const value of ['balanced', 'strict']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value === 'strict' ? 'Strict' : 'Balanced';
      if ((entry.mode || 'balanced') === value) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', async () => {
      const response = await chrome.runtime.sendMessage({
        type: 'thg:setMode',
        host: entry.host,
        mode: select.value,
      });
      showMessage(
        response && response.ok
          ? `${entry.host}: ${select.value === 'strict' ? 'Strict' : 'Balanced'} mode. Reload that site's page.`
          : 'Could not change the mode.',
      );
      await reload();
    });
    mode.append(select);

    const armed = document.createElement('td');
    armed.className = 'nowrap';
    armed.textContent = new Date(entry.armedAt || Date.now()).toLocaleString();

    const blocks = document.createElement('td');
    blocks.className = 'nowrap';
    const pings = seen[entry.host] ? seen[entry.host].count : 0;
    blocks.textContent = `${entry.blocks || 0} blocked · ${pings} guard pings`;

    const actions = document.createElement('td');
    const button = document.createElement('button');
    button.className = 'danger';
    button.type = 'button';
    button.textContent = 'Turn off';
    button.addEventListener('click', async () => {
      const response = await chrome.runtime.sendMessage({ type: 'thg:unprotect', host: entry.host });
      if (response && response.ok) {
        showMessage(`Disabled: ${entry.host}`);
        await reload();
      } else {
        showMessage('Could not disable this site.');
      }
    });
    actions.append(button);

    row.append(host, mode, armed, blocks, actions);
    body.append(row);
  }
}

function renderExceptions(exceptions) {
  const list = el('exceptions');
  list.textContent = '';
  el('exceptions-empty').hidden = exceptions.length > 0;

  for (const entry of [...exceptions].sort()) {
    const item = document.createElement('li');
    item.textContent = entry;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = `Remove ${entry}`;
    remove.textContent = '×';
    remove.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'thg:removeException', host: entry });
      showMessage(`Exception removed: ${entry}`);
      await reload();
    });

    item.append(remove);
    list.append(item);
  }
}

function renderLog(log) {
  const body = el('log');
  body.textContent = '';
  el('log-empty').hidden = log.length > 0;
  el('log-note').textContent = `${log.length} entries (max 300, newest first)`;

  for (const entry of log.slice(0, 100)) {
    const row = document.createElement('tr');

    const time = document.createElement('td');
    time.className = 'nowrap';
    time.textContent = new Date(entry.ts).toLocaleTimeString();

    const host = document.createElement('td');
    host.className = 'mono nowrap';
    host.textContent = entry.host;

    const reason = document.createElement('td');
    reason.className = 'nowrap';
    reason.textContent = REASONS[entry.reason] || entry.reason;

    const url = document.createElement('td');
    url.className = 'mono url-cell';
    url.title = entry.url || '';
    url.textContent = entry.url || '(empty)';

    const actions = document.createElement('td');
    actions.className = 'row-actions';

    if (entry.url) {
      const open = document.createElement('button');
      open.className = 'secondary';
      open.type = 'button';
      open.textContent = 'Open';
      open.title = 'Open this URL once, bypassing the block';
      open.addEventListener('click', async () => {
        const response = await chrome.runtime.sendMessage({ type: 'thg:openBlocked', url: entry.url });
        showMessage(
          response && response.ok ? `Opened: ${entry.url}` : 'Could not open this URL (not http/https?).',
        );
      });

      const allowHost = document.createElement('button');
      allowHost.className = 'secondary';
      allowHost.type = 'button';
      allowHost.textContent = 'Allow site';
      allowHost.title = 'Add the target host to the cross-domain exceptions';
      allowHost.addEventListener('click', async () => {
        let host = '';
        try {
          host = new URL(entry.url).hostname;
        } catch (_) {
          showMessage('Invalid URL.');
          return;
        }
        const response = await chrome.runtime.sendMessage({ type: 'thg:addException', host });
        showMessage(response && response.ok ? `Exception added: ${host}` : 'Could not add the exception.');
        await reload();
      });

      actions.append(open, allowHost);
    }

    row.append(time, host, reason, url, actions);
    body.append(row);
  }
}

function renderDiag(diag) {
  const body = el('diag');
  body.textContent = '';
  el('diag-empty').hidden = diag.length > 0;

  for (const entry of diag.slice(0, 50)) {
    const row = document.createElement('tr');

    const time = document.createElement('td');
    time.className = 'nowrap';
    time.textContent = new Date(entry.ts).toLocaleTimeString();

    const opener = document.createElement('td');
    opener.className = 'mono nowrap';
    opener.textContent = entry.openerHost || (entry.openerTabId != null ? `tab#${entry.openerTabId}` : '—');

    const target = document.createElement('td');
    target.className = 'mono url-cell';
    target.title = entry.newHost || entry.url || '';
    target.textContent = entry.newHost || entry.url || '—';

    const verdict = document.createElement('td');
    verdict.textContent = VERDICTS[entry.verdict] || entry.verdict || '—';

    row.append(time, opener, target, verdict);
    body.append(row);
  }
}

async function reload() {
  const state = await loadState();
  renderHosts(state.hosts, state.seen);
  renderExceptions(state.exceptions);
  renderLog(state.log);
  renderDiag(state.diag);
}

el('clear-log').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'thg:clearLog' });
  showMessage('Log and diagnostics cleared.');
  await reload();
});

el('add-exception').addEventListener('click', async () => {
  const input = el('exception-input');
  const value = input.value.trim();
  if (!value) return;

  const response = await chrome.runtime.sendMessage({ type: 'thg:addException', host: value });
  if (response && response.ok) {
    input.value = '';
    showMessage(`Exception added: ${response.host}`);
    await reload();
  } else {
    showMessage(`Invalid host: ${value}`);
  }
});

el('exception-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') el('add-exception').click();
});

el('export').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'thg:export' });
  const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'popguard-backup.json';
  link.click();
  URL.revokeObjectURL(url);
});

el('import').addEventListener('click', () => el('file').click());

el('file').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const data = JSON.parse(await file.text());
    const response = await chrome.runtime.sendMessage({ type: 'thg:import', data });
    showMessage(
      response && response.ok
        ? `Import finished: ${response.imported} sites enabled.`
        : 'Import failed: ' + ((response && response.error) || 'unknown error'),
    );
    await reload();
  } catch (error) {
    showMessage('Invalid file: ' + String((error && error.message) || error));
  } finally {
    event.target.value = '';
  }
});

reload();
