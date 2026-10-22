let fetching = false;let saving = false;let initialized = false;
let refreshTimer;let stopped = false;let inView = true;let observer;
let refreshModels = true;let revision = 0;let snapshot;let modelOptionsKey;let effortOptionsKey;
let currentSetting = { enabled: false, executor: 'hermes' };
const $ = id => document.getElementById(id);
const executorName = executor => executor === 'hermes' ? 'Hermes' : 'DSH';
const routeKey = route => route ? JSON.stringify([route.provider, route.model]) : '';
// Only catalog IDs are ever shown. Unfamiliar effort IDs stay readable as raw
// values instead of being mapped or invented.
const EFFORT_LABELS = { none: '无', off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };
const effortLabel = value => EFFORT_LABELS[value] ? `${EFFORT_LABELS[value]}（${value}）` : value;
const optionElements = options => options.map(([value, text, disabled]) => {
  const option = document.createElement('option');
  option.value = value;option.textContent = text;option.disabled = Boolean(disabled);return option;
});

function renderModels() {
  const executor = $('delegation-executor').value;
  const runtime = snapshot?.worker.executors[executor];
  const models = runtime?.models ?? [];
  const selected = currentSetting.executor === executor ? routeKey(currentSetting.route) : '';
  const options = [['', `跟随 ${executorName(executor)} 默认`, false],
    ...models.map(model => [routeKey(model), `${model.name || model.model} · ${model.provider}`, false])];
  if (selected && !options.some(([value]) => value === selected)) {
    options.push([selected, `${currentSetting.route.model} · ${currentSetting.route.provider}（当前不可用）`, true]);
  }
  const key = JSON.stringify([executor, options]);
  if (key !== modelOptionsKey) {
    $('delegation-model').replaceChildren(...optionElements(options));
    modelOptionsKey = key;
  }
  $('delegation-model').value = selected;
  const disabled = !window.agentsHost || saving || stopped || !runtime?.online || Boolean(runtime.catalog_error) || !models.length;
  $('delegation-model').disabled = disabled;
  $('model-help').textContent = !runtime?.online ? `${executorName(executor)} 未连接，连接后可选择模型。`
    : runtime.catalog_error ? '模型目录暂时不可用，请稍后重试。'
    : !models.length ? '此执行端暂未提供可用模型。'
    : selected && !models.some(model => routeKey(model) === selected) ? '所选模型当前不可用，请重新选择。'
    : '新任务使用所选模型，已有任务沿用原会话配置。';
  renderEfforts({ executor, runtime, models, selected, modelDisabled: disabled });
}

// A thinking strength is pinned to the selected provider/model pair and comes
// only from the executor catalog's efforts. Following the model default omits
// effort entirely; switching model or executor clears any pinned strength.
function renderEfforts({ executor, runtime, models, selected, modelDisabled }) {
  const select = $('delegation-effort');
  const entry = models.find(model => routeKey(model) === selected);
  const efforts = entry && Array.isArray(entry.efforts) ? entry.efforts.filter(value => typeof value === 'string' && value) : [];
  const saved = currentSetting.executor === executor && routeKey(currentSetting.route) === selected ? currentSetting.effort ?? '' : '';
  const options = [['', '跟随模型默认', false], ...efforts.map(value => [value, effortLabel(value), false])];
  if (saved && !options.some(([value]) => value === saved)) {
    options.push([saved, `${effortLabel(saved)}（当前不可用）`, true]);
  }
  const key = JSON.stringify([selected, options]);
  if (key !== effortOptionsKey) {
    select.replaceChildren(...optionElements(options));
    effortOptionsKey = key;
  }
  select.value = selected ? saved : '';
  select.disabled = modelDisabled || !selected || !efforts.length;
  $('effort-help').textContent = !runtime?.online ? `${executorName(executor)} 未连接，连接后可设置思考强度。`
    : runtime.catalog_error ? '模型目录暂时不可用，请稍后重试。'
    : !selected ? '先选择具体模型，思考强度会绑定在该提供方和模型上。'
    : !efforts.length ? '此模型目录未提供思考强度选项，新任务跟随模型默认。'
    : saved && !efforts.includes(saved) ? '所选思考强度当前不可用，请重新选择。'
    : entry?.default_effort ? `目录默认强度为 ${entry.default_effort}；跟随默认时不显式传入强度。`
    : '跟随默认时不显式传入强度；显式强度会绑定当前模型，已有任务沿用原会话配置。';
}

function updateConnection() {
  const executor = $('delegation-executor').value;
  const online = Boolean(snapshot?.worker.executors[executor]?.online);
  $('online-dot').className = 'dot' + (online ? ' online' : '');
  $('online-label').textContent = `${executorName(executor)} ${online ? '已连接' : '未连接'}`;
}

function renderActivation() {
  const status = snapshot?.activation?.status ?? 'unknown';
  $('delegation-state').textContent = !currentSetting.enabled ? '已关闭' : status === 'ready' ? '已开启'
    : status === 'checking' ? '已开启 · 检查中' : status === 'unknown' ? '已开启 · 未确认' : '已开启 · 待生效';
  const messages = {
    checking: '正在检查自动派工 Hook…',
    untrusted: '尚未生效：在 Codex CLI 输入 /hooks，审核并信任 Agents 看板的 UserPromptSubmit Hook，再重新加载旧会话。',
    modified: '尚未生效：自动派工 Hook 已更改。请在 Codex CLI 的 /hooks 中重新审核并信任，再重新加载旧会话。',
    disabled: '尚未生效：自动派工 Hook 已停用，请在 Codex CLI 的 /hooks 中启用它，再重新加载旧会话。',
    missing: '尚未生效：未检测到自动派工 Hook。请启用 Agents 看板插件，并重新加载会话。',
    missing_installation: '无法检查 Hook：请按安装教程重新安装看板，并指定 Codex CLI 路径。',
    ready: 'Hook 已信任。设置供已加载插件的会话在下一条消息使用；旧会话请先重新加载。',
    unknown: '未能确认 Hook 状态。开关已保存不代表派工已生效，请在 Codex CLI 的 /hooks 中检查。',
  };
  $('activation-message').textContent = messages[status] ?? messages.unknown;
  $('activation-message').className = 'activation-message' + (['ready', 'checking'].includes(status) ? '' : ' error');
}

function render(data, requestRevision) {
  snapshot = data;
  if (!saving && requestRevision === revision) {
    currentSetting = data.delegation;
    $('delegation-switch').checked = currentSetting.enabled;
    $('delegation-executor').value = currentSetting.executor;
    $('delegation-switch').disabled = $('delegation-executor').disabled = !window.agentsHost;
    renderModels();
    if (currentSetting.error) {
      $('delegation-message').className = 'setting-message error';
      $('delegation-message').textContent = currentSetting.error;
    }
  }
  updateConnection();
  renderActivation();
  if (!window.agentsHost) {
    $('delegation-message').textContent = '请在 Codex 的 Agents 看板中设置自动派工与模型。';
  }
}

async function saveSetting({ executorChanged = false } = {}) {
  if (saving || !window.agentsHost) { return; }
  revision++;saving = true;
  const executor = $('delegation-executor').value;
  const selected = executorChanged ? '' : $('delegation-model').value;
  const input = { enabled: $('delegation-switch').checked, executor };
  if (selected) {
    const [provider, model] = JSON.parse(selected);input.route = { provider, model };
    const effort = $('delegation-effort').value;
    if (effort) input.effort = effort;
  }
  $('delegation-switch').disabled = $('delegation-executor').disabled = $('delegation-model').disabled = true;
  $('delegation-effort').disabled = true;
  try {
    currentSetting = await window.agentsHost.call('panel_settings', input);
    $('delegation-message').className = 'setting-message';
    $('delegation-message').textContent = '设置已保存。';
  } catch (error) {
    $('delegation-message').className = 'setting-message error';
    $('delegation-message').textContent = '保存失败：' + error.message;
  } finally {
    saving = false;
    $('delegation-switch').checked = currentSetting.enabled;
    $('delegation-executor').value = currentSetting.executor;
    $('delegation-switch').disabled = $('delegation-executor').disabled = stopped;
    renderModels();updateConnection();renderActivation();
    if (executorChanged) { refreshModels = true; }
    void refresh();
  }
}
$('delegation-switch').addEventListener('change', () => void saveSetting());
$('delegation-executor').addEventListener('change', () => {
  renderModels();updateConnection();void saveSetting({ executorChanged: true });
});
// A different model means the old pinned strength no longer applies; clear it
// before saving so the server never pairs a stale effort with a new route.
$('delegation-model').addEventListener('change', () => { $('delegation-effort').value = '';void saveSetting(); });
$('delegation-effort').addEventListener('change', () => void saveSetting());

// Plugin updates. First-visible load requests a shared daily check; status only
// reads cached state, manual check bypasses the daily limit. Actions start a bounded
// status poll. There is no permanent updater poll; the poll pauses while the
// board is hidden or out of view. The client only ever sends an action.
let updateStatus;let updateBusy = false;let updatePoll;let updateError = '';let updatePollExhausted = false;
let updateReminderChecked = false;
const READONLY_UPDATE = '请在 Codex 的 Agents 看板中检查更新。';
const UPDATE_MESSAGES = {
  idle: '尚未检查更新。',
  checking: '正在检查更新…',
  up_to_date: '已是最新版本。',
  available: '发现可用更新。',
  blocked: '已阻止更新。',
  updating: '正在安装更新…',
  updated: '更新完成。',
  failed: '更新失败。',
};
const UPDATE_SUMMARIES = {
  idle: '检查并安装 GitHub 默认分支更新',
  checking: '正在检查更新…',
  up_to_date: '已是最新版本',
  available: '发现可用更新',
  blocked: '已阻止更新',
  updating: '正在安装更新…',
  updated: '更新完成',
  failed: '更新失败',
};
const updateWorking = () => ['checking', 'updating'].includes(updateStatus?.status);

function renderUpdate() {
  const host = Boolean(window.agentsHost);
  const status = updateStatus?.status ?? 'idle';
  const message = updateStatus?.message || updateStatus?.blocked_reason || updateStatus?.reason || '';
  // A blocked/failed update that left an unfinished install must still offer the
  // retry-apply entry; the backend resumes the install without re-merging.
  const pendingInstall = updateStatus?.pending_install === true;
  const retryInstall = pendingInstall && !['checking', 'updating', 'updated'].includes(status);
  $('update-current').textContent = updateStatus?.current ?? '—';
  $('update-latest').textContent = updateStatus?.latest ?? '—';
  $('update-branch').textContent = updateStatus?.branch ?? '—';
  $('update-summary-meta').textContent = pendingInstall && status === 'blocked' ? '安装未完成，可重试'
    : UPDATE_SUMMARIES[status] ?? UPDATE_SUMMARIES.idle;
  let text = host ? (message || UPDATE_MESSAGES[status] || UPDATE_MESSAGES.idle) : READONLY_UPDATE;
  if (host && retryInstall) {
    text = `${text} 上次安装尚未完成，可点击「安装更新」重试安装。`;
  }
  if (host && updatePollExhausted && updateWorking()) {
    // The bounded poll gave up, but the helper may still be working. Keep the
    // last real state and hand re-reading to the always-available refresh button.
    text = `${text} 后台可能仍在处理，请稍后点击「刷新状态」查看结果。`;
  }
  if (status === 'failed' && updateStatus?.recovery && !text.includes(updateStatus.recovery)) {
    text = `${text} ${updateStatus.recovery}`;
  }
  // Never imply an automatic app restart: ask for the reload only when the
  // backend reports it and the message does not already spell it out.
  if (status === 'updated' && updateStatus?.restart_required && !/重新加载|重启/.test(text)) {
    text = `${text} 请重新加载 Codex 或重启 DSH 后再使用新版本。`;
  }
  // A dropped board connection is not a failed install: surface it separately
  // and keep the last known state visible so a refresh can recover.
  if (host && updateError) text = `${updateError} ${text}`;
  $('update-message').textContent = text;
  $('update-message').className = 'sdd-message' + (updateError || ['failed', 'blocked'].includes(status) ? ' error' : '');
  $('update-refresh').disabled = !host || updateBusy || stopped;
  $('update-check').disabled = !host || updateBusy || stopped || updateWorking();
  $('update-apply').disabled = !host || updateBusy || stopped || !(status === 'available' || retryInstall);
}

async function loadUpdate(action) {
  if (!window.agentsHost || updateBusy) return;
  updateBusy = true;
  updateError = '';
  renderUpdate();
  try {
    updateStatus = await window.agentsHost.call('panel_update', { action });
    if (action !== 'status') updatePollExhausted = false;
    // A manual or final status read settles any poll still waiting on a timer.
    if (action === 'status' && !updateWorking()) stopUpdatePoll();
  } catch (error) {
    // Keep the last known state: a closed/slow board connection or a temporary
    // backend hiccup is not a final install failure. The refresh button retries.
    updateError = `状态读取失败（${error.message}），可稍后点击「刷新状态」重试。`;
  } finally {
    updateBusy = false;
    renderUpdate();
  }
  // Both check and apply hand long work to a detached helper and answer with
  // the active state first, so a bounded status poll follows either action.
  if (action !== 'status' && updateWorking()) scheduleUpdatePoll();
}

function clearUpdateTimer() {
  if (updatePoll?.timer != null) { clearTimeout(updatePoll.timer);updatePoll.timer = null; }
}
function stopUpdatePoll() { clearUpdateTimer();updatePoll = null; }
function scheduleUpdatePoll(attempts = 8) {
  stopUpdatePoll();
  updatePollExhausted = false;
  updatePoll = { attempts };
  armUpdatePoll();
}
function armUpdatePoll() {
  if (!updatePoll || updatePoll.timer != null || !updatePoll.attempts
      || stopped || document.hidden || !inView || !window.agentsHost) return;
  updatePoll.timer = setTimeout(async () => {
    if (!updatePoll) return;
    updatePoll.timer = null;
    updatePoll.attempts--;
    await loadUpdate('status');
    if (!updatePoll) return;
    if (!updateWorking()) { stopUpdatePoll(); return; }
    if (!updatePoll.attempts) {
      updatePollExhausted = true;
      stopUpdatePoll();
      renderUpdate();
      return;
    }
    armUpdatePoll();
  }, 1500);
}

$('update').addEventListener('toggle', () => {
  // Opening the card reads cached state; it never bypasses the daily limit.
  if ($('update').open && !updateBusy) void loadUpdate('status');
});
$('update-refresh').addEventListener('click', () => void loadUpdate('status'));
$('update-check').addEventListener('click', () => void loadUpdate('check'));
$('update-apply').addEventListener('click', () => void loadUpdate('apply'));
renderUpdate();

async function refresh() {
  if (fetching || saving || stopped || document.hidden || !inView) { return; }
  fetching = true;
  const requestRevision = revision;
  const args = initialized ? { executor: $('delegation-executor').value } : {};
  if (refreshModels) { args.refresh_models = true;refreshModels = false; }
  try {
    if (window.agentsHost) { render(await window.agentsHost.call('panel_snapshot', args), requestRevision); }
    else {
      const response = await fetch('/api/snapshot', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) { throw new Error('HTTP ' + response.status); }
      render(await response.json(), requestRevision);
    }
    initialized = true;
    // Once per page lifetime, only after a successful visible connection. The
    // server shares the 24-hour claim across windows; never auto-apply.
    if (!updateReminderChecked && !updateBusy && !stopped && !document.hidden && inView && window.agentsHost) {
      updateReminderChecked = true;
      void loadUpdate('check_daily');
    }
  } catch {
    if (!saving && requestRevision === revision) {
      $('delegation-switch').disabled = $('delegation-executor').disabled = $('delegation-model').disabled = $('delegation-effort').disabled = true;
      $('online-dot').className = 'dot';$('online-label').textContent = '未连接';
      $('model-help').textContent = '设置连接中断，正在重连。';
    }
    refreshModels = true;
  } finally {
    fetching = false;
    if (refreshModels && !saving && !stopped && !document.hidden && inView && requestRevision !== revision) { void refresh(); }
    else { scheduleRefresh(); }
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!stopped && !document.hidden && inView) { refreshTimer = setTimeout(() => void refresh(), 1000); }
}
function visibilityChanged() {
  clearTimeout(refreshTimer);
  if (!stopped && !document.hidden && inView) {
    void refresh();
    // A finite update poll resumes on return instead of running while hidden.
    armUpdatePoll();
  } else {
    clearUpdateTimer();
  }
}
function stopRefresh() {
  stopped = true;clearTimeout(refreshTimer);stopUpdatePoll();observer?.disconnect();
}
document.addEventListener('visibilitychange', visibilityChanged);
window.addEventListener('pagehide', () => { inView = false;clearTimeout(refreshTimer);clearUpdateTimer(); });
window.addEventListener('pageshow', () => { inView = true;visibilityChanged(); });
window.agentsHost?.onClose(stopRefresh);
if (typeof IntersectionObserver !== 'undefined') {
  observer = new IntersectionObserver(entries => {
    const visible = entries.some(entry => entry.isIntersecting);
    if (visible !== inView) { inView = visible;visibilityChanged(); }
  });
  observer.observe(document.documentElement);
}
void refresh();
