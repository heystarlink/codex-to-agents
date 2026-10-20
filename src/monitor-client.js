const labels = { running:'运行中', idle:'空闲', unloaded:'未加载', unknown:'状态未知' };
const active = new Set(['queued','dispatching','executing']);
let fetching = false;
const $ = id => document.getElementById(id);

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function render(data) {
  $('online-dot').className = 'dot' + (data.worker.online ? ' online' : '');
  $('online-label').textContent = data.worker.online ? '已连接' : '未连接';
  const notice = !data.worker.online ? '执行端未连接，暂时无法获取实时状态。'
    : data.warnings.length || data.worker.catalog_error ? '部分状态暂时无法获取。' : '';
  $('notice').textContent = notice;
  $('notice').classList.toggle('hidden', !notice);
  $('agents').replaceChildren();
  if (!data.agents.length) $('agents').append(node('div', '暂无 Agent，派发任务后会显示在这里。', 'empty'));
  for (const agent of data.agents) {
    const status = agent.stale ? 'unknown' : agent.status;
    const card = node('article', undefined, 'agent');
    const head = node('div', undefined, 'agent-head');
    head.append(node('span', agent.model ?? 'Agent', 'model'),
      node('span', labels[status] ?? status, 'status' + (status === 'running' ? ' running' : '')));
    card.append(head);
    if (agent.latest_title) {
      const current = status === 'running' && active.has(agent.latest_task_status);
      card.append(node('p', (current ? '正在做：' : '最近：') + agent.latest_title, 'task'));
    }
    $('agents').append(card);
  }
}

async function refresh() {
  if (fetching) return;
  fetching = true;
  try {
    const response = await fetch('/api/snapshot', { cache:'no-store', signal:AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    render(await response.json());
  } catch {
    $('online-dot').className = 'dot';
    $('online-label').textContent = '未连接';
    $('notice').classList.remove('hidden');
    $('notice').textContent = '监控连接中断，正在重连。';
    for (const badge of document.querySelectorAll('.status')) {
      badge.className = 'status';badge.textContent = '状态未知';
    }
    for (const task of document.querySelectorAll('.task')) task.textContent = task.textContent.replace(/^正在做：/, '最近：');
  } finally { fetching = false; }
}

void refresh();
setInterval(() => void refresh(), 1000);
