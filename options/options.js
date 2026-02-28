// LunchTube - Options Page Script

const $ = (id) => document.getElementById(id);

// Helper null-safe para setar textContent
function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

// ─── Navigation ───────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const section = item.dataset.section;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(`section-${section}`)?.classList.add('active');
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

  const start = $('lunch-start');
  const end   = $('lunch-end');
  const dur   = $('max-duration');
  const cnt   = $('video-count');

  if (start) start.value = settings.lunchStart;
  if (end)   end.value   = settings.lunchEnd;
  if (dur)   dur.value   = settings.maxDurationMinutes;
  if (cnt)   cnt.value   = settings.videoCount;

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
  if (diff > 0) setText('preview-duration', diff);
}

function updateDurationValue(val) {
  setText('max-duration-value', `${val} min`);
}

function updateCountValue(val) {
  setText('video-count-value', `${val} ${val == 1 ? 'vídeo' : 'vídeos'}`);
}

// ─── Live Updates ─────────────────────────────────────────────────────────────
$('lunch-start')?.addEventListener('change', () => {
  updateLunchPreview($('lunch-start')?.value, $('lunch-end')?.value);
});

$('lunch-end')?.addEventListener('change', () => {
  updateLunchPreview($('lunch-start')?.value, $('lunch-end')?.value);
});

$('max-duration')?.addEventListener('input', (e) => {
  updateDurationValue(e.target.value);
});

$('video-count')?.addEventListener('input', (e) => {
  updateCountValue(e.target.value);
});

// ─── Save Settings ────────────────────────────────────────────────────────────
$('btn-save')?.addEventListener('click', async () => {
  const settings = {
    lunchStart:          $('lunch-start')?.value   || '12:00',
    lunchEnd:            $('lunch-end')?.value     || '13:00',
    maxDurationMinutes:  parseInt($('max-duration')?.value || '20'),
    videoCount:          parseInt($('video-count')?.value  || '10'),
  };

  await chrome.storage.sync.set({ settings });
  await chrome.storage.local.remove('videoCache');

  const msg = $('save-message');
  if (msg) {
    msg.textContent = '✓ Configurações salvas!';
    msg.classList.add('visible');
    setTimeout(() => msg.classList.remove('visible'), 2500);
  }
});

// ─── Google Account ───────────────────────────────────────────────────────────
$('btn-connect')?.addEventListener('click', async () => {
  const btn = $('btn-connect');
  if (btn) {
    btn.textContent = 'Conectando...';
    btn.disabled = true;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: 'AUTH_INTERACTIVE' });

    if (response?.success) {
      setText('account-name', 'Conta conectada');
      setText('account-sub',  'Recebendo sugestões personalizadas');
      setText('account-icon', '✅');
      if (btn) {
        btn.textContent = '✓ Conectado';
        btn.disabled = true;
      }
    } else {
      setText('account-sub', '⚠️ Falha na autenticação. Tente novamente.');
      if (btn) {
        btn.textContent = 'Tentar novamente';
        btn.disabled = false;
      }
    }
  } catch (err) {
    console.error('LunchTube auth error:', err);
    setText('account-sub', '⚠️ Erro inesperado. Tente novamente.');
    if (btn) {
      btn.textContent = 'Tentar novamente';
      btn.disabled = false;
    }
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadSettings();
