let fetching = false;let saving = false;let initialized = false;
let refreshTimer;let stopped = false;let inView = true;let observer;
let refreshModels = true;let revision = 0;let snapshot;let modelOptionsKey;
let currentSetting = { enabled: false, executor: 'hermes' };
const $ = id => document.getElementById(id);
const executorName = executor => executor === 'hermes' ? 'Hermes' : 'DSH';
const routeKey = route => route ? JSON.stringify([route.provider, route.model]) : '';

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
    $('delegation-model').replaceChildren(...options.map(([value, text, disabled]) => {
      const option = document.createElement('option');option.value = value;option.textContent = text;option.disabled = disabled;return option;
    }));
    modelOptionsKey = key;
  }
  $('delegation-model').value = selected;
  $('delegation-model').disabled = !window.agentsHost || saving || stopped || !runtime?.online || Boolean(runtime.catalog_error) || !models.length;
  $('model-help').textContent = !runtime?.online ? `${executorName(executor)} 未连接，连接后可选择模型。`
    : runtime.catalog_error ? '模型目录暂时不可用，请稍后重试。'
    : !models.length ? '此执行端暂未提供可用模型。'
    : selected && !models.some(model => routeKey(model) === selected) ? '所选模型当前不可用，请重新选择。'
    : '新任务使用所选模型，已有任务沿用原会话配置。';
}

function updateConnection() {
  const executor = $('delegation-executor').value;
  const online = Boolean(snapshot?.worker.executors[executor]?.online);
  $('online-dot').className = 'dot' + (online ? ' online' : '');
  $('online-label').textContent = online ? '已连接' : '未连接';
}

function render(data, requestRevision) {
  snapshot = data;
  if (!saving && requestRevision === revision) {
    currentSetting = data.delegation;
    $('delegation-switch').checked = currentSetting.enabled;
    $('delegation-executor').value = currentSetting.executor;
    $('delegation-state').textContent = currentSetting.enabled ? '已开启' : '已关闭';
    $('delegation-switch').disabled = $('delegation-executor').disabled = !window.agentsHost;
    renderModels();
    if (currentSetting.error) {
      $('delegation-message').className = 'setting-message error';
      $('delegation-message').textContent = currentSetting.error;
    }
  }
  updateConnection();
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
  }
  $('delegation-switch').disabled = $('delegation-executor').disabled = $('delegation-model').disabled = true;
  try {
    currentSetting = await window.agentsHost.call('panel_settings', input);
    $('delegation-message').className = 'setting-message';
    $('delegation-message').textContent = '已保存，从下一条消息生效。';
  } catch (error) {
    $('delegation-message').className = 'setting-message error';
    $('delegation-message').textContent = '保存失败：' + error.message;
  } finally {
    saving = false;
    $('delegation-switch').checked = currentSetting.enabled;
    $('delegation-executor').value = currentSetting.executor;
    $('delegation-state').textContent = currentSetting.enabled ? '已开启' : '已关闭';
    $('delegation-switch').disabled = $('delegation-executor').disabled = stopped;
    renderModels();updateConnection();
    if (executorChanged) { refreshModels = true; }
    void refresh();
  }
}
$('delegation-switch').addEventListener('change', () => void saveSetting());
$('delegation-executor').addEventListener('change', () => {
  renderModels();updateConnection();void saveSetting({ executorChanged: true });
});
$('delegation-model').addEventListener('change', () => void saveSetting());

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
  } catch {
    if (!saving && requestRevision === revision) {
      $('delegation-switch').disabled = $('delegation-executor').disabled = $('delegation-model').disabled = true;
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
  if (!stopped && !document.hidden && inView) { void refresh(); }
}
function stopRefresh() {
  stopped = true;clearTimeout(refreshTimer);observer?.disconnect();
}
document.addEventListener('visibilitychange', visibilityChanged);
window.addEventListener('pagehide', () => { inView = false;clearTimeout(refreshTimer); });
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
