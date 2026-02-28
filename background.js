// LunchTube - Background Service Worker
// Handles YouTube API, lunch time detection, video caching

const CACHE_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

// ─── Default Settings ───────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  lunchStart: '12:00',
  lunchEnd: '13:00',
  maxDurationMinutes: 20,
  videoCount: 10,
};

// ─── Alarm Setup ─────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get('settings');
  if (!existing.settings) {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  }
  // Always wipe cache on install/update to avoid stale/malformed data
  await chrome.storage.local.remove('videoCache');
  chrome.alarms.create('lunchCheck', { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'lunchCheck') {
    await refreshIfLunchTime();
  }
});

// ─── Lunch Time Detection ────────────────────────────────────────────────────
function isLunchTime(settings) {
  const now = new Date();
  const [startH, startM] = settings.lunchStart.split(':').map(Number);
  const [endH, endM] = settings.lunchEnd.split(':').map(Number);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

function minutesUntilLunch(settings) {
  const now = new Date();
  const [startH, startM] = settings.lunchStart.split(':').map(Number);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const diff = startMinutes - currentMinutes;
  return diff > 0 ? diff : 24 * 60 + diff;
}

// ─── Cache Management ────────────────────────────────────────────────────────
async function getCachedVideos() {
  const { videoCache } = await chrome.storage.local.get('videoCache');
  if (!videoCache) return null;
  if (Date.now() - videoCache.timestamp > CACHE_DURATION_MS) return null;
  return videoCache.videos;
}

async function setCachedVideos(videos, usedMock = false, apiError = null, displayCount = null, shownIds = []) {
  const { videoCache: oldCache } = await chrome.storage.local.get('videoCache');
  const count = displayCount !== null ? displayCount : (oldCache?.displayCount || videos.length);
  const updatedShownIds = Array.from(new Set([...shownIds, ...videos.map(v => v.id)]));
  
  await chrome.storage.local.set({
    videoCache: { 
      videos, 
      usedMock, 
      apiError, 
      displayCount: count, 
      shownIds: updatedShownIds,
      timestamp: Date.now() 
    }
  });
}

// ─── YouTube API ─────────────────────────────────────────────────────────────
async function getAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(chrome.runtime.lastError || new Error('No token'));
      } else {
        resolve(token);
      }
    });
  });
}

async function fetchSubscriptions(token) {
  const url = `${YOUTUBE_API_BASE}/subscriptions?part=snippet&mine=true&maxResults=50&order=relevance`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Subscriptions API error: ${res.status}`);
  const data = await res.json();
  return (data.items || []).map(item => item.snippet.resourceId.channelId);
}

async function fetchRecentVideosFromChannel(token, channelId, maxResults = 5) {
  // Get uploads playlist for channel
  const channelRes = await fetch(
    `${YOUTUBE_API_BASE}/channels?part=contentDetails&id=${channelId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!channelRes.ok) return [];
  const channelData = await channelRes.json();
  const playlistId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) return [];

  // Get recent videos from uploads playlist
  const playlistRes = await fetch(
    `${YOUTUBE_API_BASE}/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!playlistRes.ok) return [];
  const playlistData = await playlistRes.json();
  return (playlistData.items || []).map(item => item.snippet.resourceId.videoId);
}

async function fetchVideoDetails(token, videoIds) {
  if (videoIds.length === 0) return [];
  const ids = videoIds.join(',');
  const res = await fetch(
    `${YOUTUBE_API_BASE}/videos?part=snippet,contentDetails,statistics&id=${ids}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.items || [];
}

// ─── Duration Parsing ─────────────────────────────────────────────────────────
function parseDurationToSeconds(iso8601) {
  const match = iso8601.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || '0');
  const minutes = parseInt(match[2] || '0');
  const seconds = parseInt(match[3] || '0');
  return hours * 3600 + minutes * 60 + seconds;
}

function formatDuration(iso8601) {
  const total = parseDurationToSeconds(iso8601);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── Engagement Score ─────────────────────────────────────────────────────────
function engagementScore(stats) {
  const views = parseInt(stats.viewCount || '1');
  const likes = parseInt(stats.likeCount || '0');
  const comments = parseInt(stats.commentCount || '0');
  return (likes + comments * 2) / Math.max(views, 1);
}

// ─── Shorts Detection ─────────────────────────────────────────────────────────
function isShort(video) {
  const dur = parseDurationToSeconds(video.contentDetails?.duration || 'PT0S');
  const title = (video.snippet?.title || '').toLowerCase();
  const desc = (video.snippet?.description || '').toLowerCase();
  
  // 1. Durantion check: YouTube Shorts are typically ≤ 60s, but we use 90s to be safe
  if (dur > 0 && dur <= 90) return true;
  
  // 2. Hashtag and keyword check in title and description
  if (title.includes('#shorts') || title.includes('#short') || title.includes('shorts')) return true;
  if (desc.includes('#shorts') || desc.includes('#short')) return true;

  return false;
}

// ─── Watched Videos ────────────────────────────────────────────────────────────
async function getWatchedIds() {
  const { watchedVideos } = await chrome.storage.local.get({ watchedVideos: [] });
  return new Set(watchedVideos);
}

async function markVideoWatched(videoId) {
  const watched = await getWatchedIds();
  watched.add(videoId);
  // Keep only last 500 watched IDs to avoid unbounded growth
  const arr = Array.from(watched).slice(-500);
  await chrome.storage.local.set({ watchedVideos: arr });
}

// ─── Mock Data (used when API not configured or fails) ───────────────────────
function getMockVideos(count) {
  const mockData = [
    {
      id: 'mock-1',
      title: 'Como ser mais produtivo no trabalho',
      channel: 'Produtividade Plus',
      thumbnail: 'https://picsum.photos/seed/productivity/320/180',
      duration: '12:34',
      durationSeconds: 754,
      score: 0.045,
      views: '1.2M'
    },
    {
      id: 'mock-2',
      title: 'Os segredos da alimentação saudável',
      channel: 'Saúde em Foco',
      thumbnail: 'https://picsum.photos/seed/food/320/180',
      duration: '8:20',
      durationSeconds: 500,
      score: 0.038,
      views: '890K'
    },
    {
      id: 'mock-3',
      title: 'Aprenda JavaScript em 15 minutos',
      channel: 'Dev Rápido',
      thumbnail: 'https://picsum.photos/seed/coding/320/180',
      duration: '15:00',
      durationSeconds: 900,
      score: 0.062,
      views: '2.1M'
    },
    {
      id: 'mock-4',
      title: 'Receitas rápidas para o almoço',
      channel: 'Culinária Express',
      thumbnail: 'https://picsum.photos/seed/kitchen/320/180',
      duration: '10:15',
      durationSeconds: 615,
      score: 0.051,
      views: '560K'
    },
    {
      id: 'mock-5',
      title: 'Meditação guiada de 10 minutos',
      channel: 'Mente Zen',
      thumbnail: 'https://picsum.photos/seed/meditation/320/180',
      duration: '10:00',
      durationSeconds: 600,
      score: 0.072,
      views: '3.4M'
    },
    {
      id: 'mock-6',
      title: 'Design Thinking na prática',
      channel: 'UX Brasil',
      thumbnail: 'https://picsum.photos/seed/design/320/180',
      duration: '18:45',
      durationSeconds: 1125,
      score: 0.041,
      views: '445K'
    },
    {
      id: 'mock-7',
      title: 'Finanças pessoais: como economizar',
      channel: 'Dinheiro Inteligente',
      thumbnail: 'https://picsum.photos/seed/finance/320/180',
      duration: '14:22',
      durationSeconds: 862,
      score: 0.058,
      views: '1.8M'
    },
    {
      id: 'mock-8',
      title: 'Top 10 extensões para desenvolvedores',
      channel: 'CodeBrasil',
      thumbnail: 'https://picsum.photos/seed/tech/320/180',
      duration: '11:50',
      durationSeconds: 710,
      score: 0.067,
      views: '720K'
    },
    {
      id: 'mock-9',
      title: 'Rotina matinal de alta performance',
      channel: 'Alta Performance',
      thumbnail: 'https://picsum.photos/seed/morning/320/180',
      duration: '9:33',
      durationSeconds: 573,
      score: 0.049,
      views: '990K'
    },
    {
      id: 'mock-10',
      title: 'Como aprender qualquer coisa mais rápido',
      channel: 'Aprendizado Acelerado',
      thumbnail: 'https://picsum.photos/seed/learning/320/180',
      duration: '16:10',
      durationSeconds: 970,
      score: 0.055,
      views: '2.5M'
    }
  ];
  return mockData.slice(0, count).sort((a, b) => b.score - a.score);
}

// ─── Main Refresh Logic ──────────────────────────────────────────────────────
async function fetchAndCacheVideos(settings, overrideCount = null, excludedIds = []) {
  try {
    const token = await getAuthToken();
    const channelIds = await fetchSubscriptions(token);

    // Fetch recent videos from first 10 subscribed channels
    const sampleChannels = channelIds.slice(0, 10);
    const videoIdArrays = await Promise.all(
      sampleChannels.map(id => fetchRecentVideosFromChannel(token, id, 3))
    );
    const allVideoIds = videoIdArrays.flat();

    // Fetch details for all collected video IDs (max 50 per request)
    const details = await fetchVideoDetails(token, allVideoIds.slice(0, 50));

    // Filter by duration, Shorts, already-watched videos, AND session-excluded IDs
    const maxSeconds = settings.maxDurationMinutes * 60;
    const watchedIds = await getWatchedIds();
    const sessionExcludedSet = new Set(excludedIds);
    
    const filtered = details.filter(v => {
      const dur = parseDurationToSeconds(v.contentDetails?.duration || 'PT0S');
      if (dur <= 0 || dur > maxSeconds) return false;  // wrong duration
      if (isShort(v)) return false;                    // exclude Shorts
      if (watchedIds.has(v.id)) return false;           // exclude history-watched
      if (sessionExcludedSet.has(v.id)) return false;  // exclude currently-shown-in-session
      return true;
    });

    const countToSlice = overrideCount !== null ? overrideCount : settings.videoCount;
    const videos = filtered
      .map(v => ({
        id: v.id,
        title: v.snippet.title,
        channel: v.snippet.channelTitle,
        thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
        duration: formatDuration(v.contentDetails.duration),
        durationSeconds: parseDurationToSeconds(v.contentDetails.duration),
        score: engagementScore(v.statistics),
        views: formatViewCount(v.statistics.viewCount)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, countToSlice);

    if (videos.length > 0) {
      await setCachedVideos(videos, false, null, countToSlice, excludedIds);
      return videos;
    }
  } catch (err) {
    const reason = err.message?.includes('403') ? 'youtube_api_disabled'
                 : err.message?.includes('token') || err.message?.includes('OAuth') ? 'not_authenticated'
                 : 'unknown';
    console.warn('LunchTube: YouTube API unavailable, using mock data.', err.message);
    const countToSlice = overrideCount !== null ? overrideCount : settings.videoCount;
    // For mock data, we filter manually since it's a static list
    const sessionExcludedSet = new Set(excludedIds);
    const mockPool = getMockVideos(20); // Get a larger pool for variety
    const mockVideos = mockPool
      .filter(v => !sessionExcludedSet.has(v.id))
      .slice(0, countToSlice);
      
    await setCachedVideos(mockVideos, true, reason, countToSlice, excludedIds);
    return mockVideos;
  }

  // Fallback to mock data (API returned no videos after filtering)
  const countToSlice = overrideCount !== null ? overrideCount : settings.videoCount;
  const mockPool = getMockVideos(20);
  const sessionExcludedSet = new Set(excludedIds);
  const mockVideos = mockPool
    .filter(v => !sessionExcludedSet.has(v.id))
    .slice(0, countToSlice);

  await setCachedVideos(mockVideos, true, 'no_results', countToSlice, excludedIds);
  return mockVideos;
}

function formatViewCount(count) {
  const n = parseInt(count || '0');
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

async function refreshIfLunchTime() {
  const { settings } = await chrome.storage.sync.get({ settings: DEFAULT_SETTINGS });
  if (isLunchTime(settings)) {
    const cached = await getCachedVideos();
    if (!cached) {
      await fetchAndCacheVideos(settings);
    }
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'GET_STATE') {
    handleGetState().then(sendResponse);
    return true;
  }
  if (request.type === 'REFRESH_VIDEOS') {
    handleRefresh().then(sendResponse);
    return true;
  }
  if (request.type === 'AUTH_INTERACTIVE') {
    handleInteractiveAuth().then(sendResponse);
    return true;
  }
  if (request.type === 'MARK_WATCHED') {
    markVideoWatched(request.videoId).then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function handleGetState() {
  const { settings } = await chrome.storage.sync.get({ settings: DEFAULT_SETTINGS });
  const lunch = isLunchTime(settings);
  const minsUntil = minutesUntilLunch(settings);

  if (lunch) {
    const { videoCache } = await chrome.storage.local.get('videoCache');
    // Guard: only use cache if videos is a real array (avoids old malformed data)
    if (videoCache?.videos && Array.isArray(videoCache.videos) && videoCache.videos.length > 0) {
      return { state: 'lunch', videos: videoCache.videos, usedMock: videoCache.usedMock, apiError: videoCache.apiError, displayCount: videoCache.displayCount, settings };
    }
    // Fetch fresh
    const videos = await fetchAndCacheVideos(settings);
    const { videoCache: vc2 } = await chrome.storage.local.get('videoCache');
    return { state: 'lunch', videos, usedMock: vc2?.usedMock, apiError: vc2?.apiError, displayCount: vc2?.displayCount, settings };
  }

  return { state: 'waiting', minutesUntil: minsUntil, settings };
}

async function handleRefresh() {
  const { settings } = await chrome.storage.sync.get({ settings: DEFAULT_SETTINGS });
  const { videoCache } = await chrome.storage.local.get('videoCache');
  
  const currentCount = videoCache?.displayCount ?? settings.videoCount;
  const newCount = Math.max(1, currentCount - 1);
  const shownIds = videoCache?.shownIds || [];
  
  // We keep the cache valid but fetch a fresh SET excluding shownIds
  const videos = await fetchAndCacheVideos(settings, newCount, shownIds);
  const { videoCache: vc2 } = await chrome.storage.local.get('videoCache');
  return { videos, usedMock: vc2?.usedMock, apiError: vc2?.apiError, displayCount: vc2?.displayCount };
}

async function handleInteractiveAuth() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError || !token) {
        resolve({ success: false, error: chrome.runtime.lastError?.message });
      } else {
        resolve({ success: true });
      }
    });
  });
}
