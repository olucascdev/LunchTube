// LunchTube - Options Page Script

const $ = (id) => document.getElementById(id);

// ─── Navigation ───────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const section = item.dataset.section;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(`section-${section}`).classList.add('active');
  });
});

// ─── Load Settings ────────────────────────────────────────────────────────────
async function loadSettings() {
  const { settings } = await chrome.storage.sync.get({
    settings: {
      lunchStart: '12:00',
      lunchEnd: '13:00',
      maxDurationMinutes: 20,
      videoCount: 10,
    }
  });

  $('lunch-start').value = settings.lunchStart;
  $('lunch-end').value = settings.lunchEnd;
  $('max-duration').value = settings.maxDurationMinutes;
  $('video-count').value = settings.videoCount;

  updateDurationValue(settings.maxDurationMinutes);
  updateCountValue(settings.videoCount);
  updateLunchPreview(settings.lunchStart, settings.lunchEnd);
}

// ─── Preview updaters ─────────────────────────────────────────────────────────
function updateLunchPreview(start, end) {
  if (!start || !end) return;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff > 0) {
    $('preview-duration').textContent = diff;
  }
}

function updateDurationValue(val) {
  $('max-duration-value').textContent = `${val} min`;
}

function updateCountValue(val) {
  $('video-count-value').textContent = `${val} ${val == 1 ? 'vídeo' : 'vídeos'}`;
}

// ─── Live Updates ────────────────────────────────────────────────────────────
$('lunch-start').addEventListener('change', () => {
  updateLunchPreview($('lunch-start').value, $('lunch-end').value);
});

$('lunch-end').addEventListener('change', () => {
  updateLunchPreview($('lunch-start').value, $('lunch-end').value);
});

$('max-duration').addEventListener('input', (e) => {
  updateDurationValue(e.target.value);
});

$('video-count').addEventListener('input', (e) => {
  updateCountValue(e.target.value);
});

// ─── Save Settings ────────────────────────────────────────────────────────────
$('btn-save').addEventListener('click', async () => {
  const settings = {
    lunchStart: $('lunch-start').value,
    lunchEnd: $('lunch-end').value,
    maxDurationMinutes: parseInt($('max-duration').value),
    videoCount: parseInt($('video-count').value),
  };

  await chrome.storage.sync.set({ settings });

  // Clear video cache so next popup load fetches fresh
  await chrome.storage.local.remove('videoCache');

  // Show success feedback
  const msg = $('save-message');
  msg.textContent = '✓ Configurações salvas!';
  msg.classList.add('visible');
  setTimeout(() => msg.classList.remove('visible'), 2500);
});

// ─── Google Account ───────────────────────────────────────────────────────────
$('btn-connect').addEventListener('click', async () => {
  $('btn-connect').textContent = 'Conectando...';
  $('btn-connect').disabled = true;

  const response = await chrome.runtime.sendMessage({ type: 'AUTH_INTERACTIVE' });

  if (response?.success) {
    $('account-name').textContent = 'Conta conectada';
    $('account-sub').textContent = 'Recebendo sugestões personalizadas';
    $('account-icon').textContent = '✅';
    $('btn-connect').textContent = '✓ Conectado';
  } else {
    $('btn-connect').textContent = 'Tentar novamente';
    $('btn-connect').disabled = false;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadSettings();
