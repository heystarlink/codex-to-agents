const labels = { running:'运行中', idle:'空闲', unloaded:'未加载', unknown:'状态未知' };
const active = new Set(['queued','dispatching','executing']);
let fetching = false;
let refreshTimer;let stopped = false;let inView = true;let observer;
let saving = false;let currentSetting = { enabled: false, executor: 'hermes' };
const $ = id => document.getElementById(id);

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function render(data) {
  if (data.service) $('service-info').textContent = `后台进程 ${data.service.name} · PID ${data.service.pid} · 内存 RSS ${data.service.rss_mib} MB`;
  if (!saving) {
    currentSetting = data.delegation;
    $('delegation-switch').checked = currentSetting.enabled;
    $('delegation-executor').value = currentSetting.executor;
    $('delegation-state').textContent = currentSetting.enabled ? '已开启' : '已关闭';
    // HTTP monitoring stays read-only; preferences are edited in the native
    // plugin so ordinary websites cannot change the user's delegation mode.
    $('delegation-switch').disabled = $('delegation-executor').disabled = !window.agentsHost;
    if (!window.agentsHost) $('delegation-message').textContent = '请在 Codex 左侧的 Agents 看板中设置自动派工。';
  }
  $('online-dot').className = 'dot' + (data.worker.online ? ' online' : '');
  $('online-label').textContent = data.worker.online ? '已连接' : '未连接';
  const notice = !data.worker.online ? '执行端未连接，暂时无法获取实时状态。'
    : data.warnings.length || data.worker.catalog_error ? '部分状态暂时无法获取。' : '';
  $('notice').textContent = notice;
  $('notice').classList.toggle('hidden', !notice);
  $('agents').replaceChildren();
  $('summary').textContent = `Hermes ${data.worker.executors.hermes.online ? '在线' : '离线'} · DSH ${data.worker.executors.dsh.online ? '在线' : '离线'} ｜ 进行中 ${data.summary.active} · 已完成 ${data.summary.completed} · 待处理 ${data.summary.problems}`;
  if (!data.agents.length) $('agents').append(node('div', '暂无 Agent，派发任务后会显示在这里。', 'empty'));
  for (const agent of data.agents) {
    const status = agent.stale ? 'unknown' : agent.status;
    const card = node('article', undefined, 'agent');
    const head = node('div', undefined, 'agent-head');
    head.append(node('span', `${agent.executor === 'hermes' ? 'Hermes' : 'DSH'} · ${agent.model ?? 'Agent'}`, 'model'),
      node('span', labels[status] ?? status, 'status' + (status === 'running' ? ' running' : '')));
    card.append(head);
    if (agent.latest_title) {
      const current = status === 'running' && active.has(agent.latest_task_status);
      card.append(node('p', (current ? '正在做：' : '最近：') + agent.latest_title, 'task'));
    }
    $('agents').append(card);
  }
  const statuses = { queued:'等待领取', dispatching:'正在派发', executing:'执行中', completed:'已完成', failed:'失败', blocked:'已阻塞', uncertain:'待核查', cancelled:'已取消' };
  $('orders').replaceChildren();
  for (const order of data.orders.slice(0, 15)) {
    const row = node('article', undefined, 'order');const head = node('div', undefined, 'order-head');
    head.append(node('span', order.title, 'order-title'), node('span', statuses[order.status] ?? order.status, 'status'));
    row.append(head, node('p', `${order.executor} · ${(order.error || order.output?.text || order.progress || '').slice(-500)}`, 'order-detail'));
    $('orders').append(row);
  }
  if (!data.orders.length) $('orders').append(node('div', '暂无任务', 'empty'));
}

async function saveSetting() {
  if (saving || !window.agentsHost) return;
  saving = true;
  $('delegation-switch').disabled = $('delegation-executor').disabled = true;
  try {
    currentSetting = await window.agentsHost.call('panel_settings', { enabled: $('delegation-switch').checked, executor: $('delegation-executor').value });
    $('delegation-state').textContent = currentSetting.enabled ? '已开启' : '已关闭';
    $('delegation-message').textContent = '已保存，从下一条消息生效。首次安装需先在 Codex 信任插件 Hook 并新建会话。';
  } catch (error) {
    $('delegation-switch').checked = currentSetting.enabled;$('delegation-executor').value = currentSetting.executor;
    $('delegation-message').textContent = '保存失败：' + error.message;
  } finally { saving = false;$('delegation-switch').disabled = $('delegation-executor').disabled = false; }
}
$('delegation-switch').addEventListener('change', () => void saveSetting());
$('delegation-executor').addEventListener('change', () => void saveSetting());

async function refresh() {
  if (fetching || stopped || document.hidden || !inView) return;
  fetching = true;
  try {
    if (window.agentsHost) render(await window.agentsHost.call('panel_snapshot'));
    else {
      const response = await fetch('/api/snapshot', { cache:'no-store', signal:AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      render(await response.json());
    }
  } catch {
    if (!saving) $('delegation-switch').disabled = $('delegation-executor').disabled = true;
    $('online-dot').className = 'dot';
    $('online-label').textContent = '未连接';
    $('notice').classList.remove('hidden');
    $('notice').textContent = '监控连接中断，正在重连。';
    for (const badge of document.querySelectorAll('.status')) {
      badge.className = 'status';badge.textContent = '状态未知';
    }
    for (const task of document.querySelectorAll('.task')) task.textContent = task.textContent.replace(/^正在做：/, '最近：');
  } finally { fetching = false;scheduleRefresh(); }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!stopped && !document.hidden && inView) refreshTimer = setTimeout(() => void refresh(), 1000);
}
function visibilityChanged() {
  clearTimeout(refreshTimer);
  if (!stopped && !document.hidden && inView) void refresh();
}
function stopRefresh() {
  stopped = true;clearTimeout(refreshTimer);observer?.disconnect();
}
document.addEventListener('visibilitychange', visibilityChanged);
window.addEventListener('pagehide', () => { inView = false;clearTimeout(refreshTimer); });
window.addEventListener('pageshow', () => { inView = true;visibilityChanged(); });
window.agentsHost?.onClose(stopRefresh);
if (typeof IntersectionObserver !== 'undefined') {
  // CSS-hidden cached iframes do not always fire visibilitychange.
  observer = new IntersectionObserver(entries => {
    const visible = entries.some(entry => entry.isIntersecting);
    if (visible !== inView) { inView = visible;visibilityChanged(); }
  });
  observer.observe(document.documentElement);
}
void refresh();
