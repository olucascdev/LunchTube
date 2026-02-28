// LunchTube - Popup Script

const $ = (id) => document.getElementById(id);

// ─── State Management ─────────────────────────────────────────────────────────
const STATES = ['loading', 'auth', 'waiting', 'lunch', 'error'];

function showState(name) {
  STATES.forEach(s => {
    const el = $(`state-${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  });
}

// ─── Countdown Timer ──────────────────────────────────────────────────────────
let countdownInterval = null;

function startCountdown(minutesUntil, settings) {
  clearInterval(countdownInterval);
  let totalMinutes = minutesUntil;

  function update() {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    $('count-h').textContent = String(h).padStart(2, '0');
    $('count-m').textContent = String(m).padStart(2, '0');
    if (totalMinutes > 0) totalMinutes--;
  }

  update();
  countdownInterval = setInterval(update, 60000);

  $('lunch-schedule').textContent = `Seu almoço começa às ${settings.lunchStart}`;
  $('subtitle').textContent = 'Fora do horário de almoço';
  showState('waiting');
}

// ─── Video Rendering ──────────────────────────────────────────────────────────
function scoreLabel(score) {
  if (score > 0.06) return 'Muito popular';
  if (score > 0.04) return 'Popular';
  return 'Em destaque';
}

function renderVideos(videos, usedMock) {
  const list = $('video-list');
  list.innerHTML = '';

  if (usedMock) {
    $('mock-badge').classList.remove('hidden');
  } else {
    $('mock-badge').classList.add('hidden');
  }

  videos.forEach((video, index) => {
    const a = document.createElement('a');
    a.className = 'video-card';
    a.href = `https://www.youtube.com/watch?v=${video.id}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.animationDelay = `${index * 40}ms`;

    a.innerHTML = `
      <div class="video-thumb-wrap">
        <img class="video-thumb" src="${video.thumbnail}" alt="${escapeHtml(video.title)}" loading="lazy" />
        <span class="video-duration">${video.duration}</span>
      </div>
      <div class="video-info">
        <span class="video-title">${escapeHtml(video.title)}</span>
        <div class="video-meta">
          <span class="video-channel">${escapeHtml(video.channel)}</span>
          <div class="video-stats">
            <span class="video-views">${video.views} views</span>
            <span class="video-score">
              <span class="score-dot"></span>
              ${scoreLabel(video.score)}
            </span>
          </div>
        </div>
      </div>
    `;

    list.appendChild(a);
  });

  $('subtitle').textContent = `${videos.length} vídeos para o almoço`;
  showState('lunch');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Main Load ────────────────────────────────────────────────────────────────
async function loadState() {
  showState('loading');
  $('subtitle').textContent = 'Carregando...';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });

    if (!response) {
      throw new Error('Sem resposta do serviço em segundo plano.');
    }

    if (response.state === 'lunch') {
      renderVideos(response.videos, response.usedMock);
    } else {
      startCountdown(response.minutesUntil, response.settings);
    }
  } catch (err) {
    console.error('LunchTube popup error:', err);
    $('error-message').textContent = err.message || 'Erro desconhecido.';
    $('subtitle').textContent = 'Erro';
    showState('error');
  }
}

// ─── Refresh ──────────────────────────────────────────────────────────────────
async function refreshVideos() {
  const btn = $('btn-refresh');
  btn.classList.add('spinning');
  btn.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'REFRESH_VIDEOS' });
    if (response?.videos) {
      renderVideos(response.videos, response.usedMock);
    }
  } catch (err) {
    console.error('Refresh error:', err);
  } finally {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function connectGoogle() {
  const response = await chrome.runtime.sendMessage({ type: 'AUTH_INTERACTIVE' });
  if (response?.success) {
    loadState();
  } else {
    alert('Falha na autenticação. Verifique as configurações da extensão.');
  }
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
$('btn-refresh').addEventListener('click', refreshVideos);

$('btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('btn-retry')?.addEventListener('click', loadState);
$('btn-auth')?.addEventListener('click', connectGoogle);
$('btn-use-mock')?.addEventListener('click', loadState);

// ─── Init ─────────────────────────────────────────────────────────────────────
loadState();
