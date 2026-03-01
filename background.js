// LunchTube - Background Service Worker
// Optimized: ~29 API quota units per user (down from ~2.602)
// Strategy: playlistItems.list (1 unit) instead of search.list (100 units)

const CACHE_DURATION_MS = 30 * 60 * 1000;
const YOUTUBE_API_BASE  = 'https://www.googleapis.com/youtube/v3';
const MAX_REFRESHES     = 3;
const CHANNELS_TO_SAMPLE = 25;

// ─── Default Settings ────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  lunchStart:        '12:00',
  lunchEnd:          '13:00',
  maxDurationMinutes: 20,
  videoCount:         6,
};

// ─── Alarm Setup ─────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get('settings');
  if (!existing.settings) await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  await chrome.storage.local.remove('videoCache');
  chrome.alarms.create('lunchCheck', { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'lunchCheck') await refreshIfLunchTime();
});

// ─── Lunch Time Detection ────────────────────────────────────────────────────
function isLunchTime(settings) {
  const now = new Date();
  const [startH, startM] = settings.lunchStart.split(':').map(Number);
  const [endH,   endM]   = settings.lunchEnd.split(':').map(Number);
  const cur   = now.getHours() * 60 + now.getMinutes();
  const start = startH * 60 + startM;
  const end   = endH   * 60 + endM;
  return cur >= start && cur < end;
}

function minutesUntilLunch(settings) {
  const now = new Date();
  const [startH, startM] = settings.lunchStart.split(':').map(Number);
  const cur   = now.getHours() * 60 + now.getMinutes();
  const start = startH * 60 + startM;
  const diff  = start - cur;
  return diff > 0 ? diff : 24 * 60 + diff;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Random date between 15 and 30 days ago — keeps results fresh but not too recent
function randomPublishedAfter() {
  const daysBack = Math.floor(Math.random() * 16) + 15;
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString();
}

function parseDurationToSeconds(iso8601) {
  const m = (iso8601 || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

function formatDuration(iso8601) {
  const total = parseDurationToSeconds(iso8601);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatViewCount(count) {
  const n = parseInt(count || '0');
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ─── Engagement Score (age-normalised) ───────────────────────────────────────
// (likes + comments×2) / views / ageInDays
// Recent videos gaining traction compete fairly with old viral ones.
function engagementScore(stats, publishedAt) {
  const views    = parseInt(stats?.viewCount    || '1');
  const likes    = parseInt(stats?.likeCount    || '0');
  const comments = parseInt(stats?.commentCount || '0');
  const raw      = (likes + comments * 2) / Math.max(views, 1);
  const ageDays  = Math.max(1, (Date.now() - new Date(publishedAt).getTime()) / 86_400_000);
  return raw / ageDays;
}

// ─── Shorts Detection ─────────────────────────────────────────────────────────
function isShort(video) {
  const dur   = parseDurationToSeconds(video.contentDetails?.duration);
  const title = (video.snippet?.title       || '').toLowerCase();
  const desc  = (video.snippet?.description || '').toLowerCase();
  if (dur > 0 && dur <= 180) return true;
  if (title.includes('#shorts') || title.includes('#short') || title.includes('shorts')) return true;
  if (desc.includes('#shorts')  || desc.includes('#short'))  return true;
  return false;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function getAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) reject(chrome.runtime.lastError || new Error('No token'));
      else resolve(token);
    });
  });
}

// ─── Cache ────────────────────────────────────────────────────────────────────
async function getCachedVideos() {
  const { videoCache } = await chrome.storage.local.get('videoCache');
  if (!videoCache) return null;
  if (Date.now() - videoCache.timestamp > CACHE_DURATION_MS) return null;
  return videoCache.videos?.length ? videoCache.videos : null;
}

async function setCachedVideos(videos, apiError = null, shownIds = []) {
  const { videoCache: old } = await chrome.storage.local.get('videoCache');
  const mergedShown = Array.from(new Set([
    ...(old?.shownIds || []),
    ...shownIds,
    ...videos.map(v => v.id),
  ]));
  await chrome.storage.local.set({
    videoCache: { videos, apiError, shownIds: mergedShown, timestamp: Date.now() }
  });
}

// ─── Refresh Counter (max 3 per lunch session) ────────────────────────────────
function lunchSessionKey(settings) {
  return `${new Date().toDateString()}_${settings.lunchStart}`;
}

async function getRemainingRefreshes(settings) {
  const { refreshState } = await chrome.storage.local.get({ refreshState: { count: 0, key: null } });
  if (refreshState.key !== lunchSessionKey(settings)) return MAX_REFRESHES;
  return Math.max(0, MAX_REFRESHES - refreshState.count);
}

async function incrementRefresh(settings) {
  const key = lunchSessionKey(settings);
  const { refreshState } = await chrome.storage.local.get({ refreshState: { count: 0, key: null } });
  const count = refreshState.key === key ? refreshState.count + 1 : 1;
  await chrome.storage.local.set({ refreshState: { count, key } });
  return Math.max(0, MAX_REFRESHES - count);
}

// ─── Watched Videos ───────────────────────────────────────────────────────────
async function getWatchedIds() {
  const { watchedVideos } = await chrome.storage.local.get({ watchedVideos: [] });
  return new Set(watchedVideos);
}

async function markVideoWatched(videoId) {
  const watched = await getWatchedIds();
  watched.add(videoId);
  await chrome.storage.local.set({ watchedVideos: Array.from(watched).slice(-500) });
}

// ─── YouTube API (low-quota only) ────────────────────────────────────────────

// 1 unit
async function fetchSubscriptions(token) {
  const res = await fetch(
    `${YOUTUBE_API_BASE}/subscriptions?part=snippet&mine=true&maxResults=50&order=relevance`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`subscriptions ${res.status}`);
  const data = await res.json();
  return (data.items || []).map(i => i.snippet.resourceId.channelId);
}

// 1 unit total — all channel IDs batched in a single request
async function fetchUploadPlaylists(token, channelIds) {
  if (!channelIds.length) return {};
  const res = await fetch(
    `${YOUTUBE_API_BASE}/channels?part=contentDetails&id=${channelIds.join(',')}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return {};
  const data = await res.json();
  const map = {};
  for (const item of data.items || []) {
    map[item.id] = item.contentDetails?.relatedPlaylists?.uploads;
  }
  return map; // { channelId → uploadPlaylistId }
}

// 1 unit each — called in parallel via Promise.all
async function fetchPlaylistVideoIds(token, playlistId, publishedAfter, maxResults = 4) {
  try {
    const res = await fetch(
      `${YOUTUBE_API_BASE}/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || [])
      .map(i => ({ id: i.snippet.resourceId.videoId, publishedAt: i.snippet.publishedAt }))
      .filter(v => v.id && new Date(v.publishedAt) >= new Date(publishedAfter));
  } catch {
    return [];
  }
}

// 1 unit — non-subscribed discovery via trending chart (replaces homepage scraping)
// Uses regionCode to keep content relevant to the user's country.
async function fetchTrendingVideos(token, regionCode = 'BR', maxResults = 20) {
  try {
    const res = await fetch(
      `${YOUTUBE_API_BASE}/videos?part=snippet,contentDetails,statistics&chart=mostPopular&regionCode=${regionCode}&maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.items || [];
  } catch {
    return [];
  }
}

// 1 unit — all IDs batched in a single request
async function fetchVideoDetails(token, videoIds) {
  if (!videoIds.length) return [];
  const res = await fetch(
    `${YOUTUBE_API_BASE}/videos?part=snippet,contentDetails,statistics&id=${videoIds.join(',')}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.items || [];
}

// ─── Main Fetch ───────────────────────────────────────────────────────────────
// Quota breakdown per call:
//   1  subscriptions.list
//   1  channels.list (all 25 IDs batched)
//  25  playlistItems.list (one per channel, in parallel)
//   1  videos.list (subscription videos batched)
//   1  videos.list (trending)
// ────────────────────
//  29 units total
async function fetchAndCacheVideos(settings, excludedIds = []) {
  try {
    const token = await getAuthToken(false);

    // Step 1 — subscriptions (1 unit)
    const allChannelIds = await fetchSubscriptions(token);

    // Step 2 — shuffle, sample 25 channels
    const sampledIds = shuffle(allChannelIds).slice(0, CHANNELS_TO_SAMPLE);

    // Step 3 — batch fetch upload playlist IDs (1 unit)
    const playlistMap = await fetchUploadPlaylists(token, sampledIds);

    // Step 4 — fetch video IDs from each playlist in parallel (25 units)
    const publishedAfter   = randomPublishedAfter();
    const playlistResults  = await Promise.all(
      Object.values(playlistMap)
        .filter(Boolean)
        .map(pid => fetchPlaylistVideoIds(token, pid, publishedAfter, 4))
    );
    const subscriptionVideoIds = shuffle(
      Array.from(new Set(playlistResults.flat().map(v => v.id).filter(Boolean)))
    );

    // Step 5 — trending videos for non-subscribed discovery (1 unit)
    const trendingItems  = await fetchTrendingVideos(token, 'BR', 20);
    const trendingIds    = new Set(trendingItems.map(v => v.id));

    // Step 6 — fetch details for subscription videos only; trending already has details (1 unit)
    const idsNeedingDetails = subscriptionVideoIds.slice(0, 30);
    const fetchedDetails    = await fetchVideoDetails(token, idsNeedingDetails);

    // Merge both pools
    const allDetails = [
      ...fetchedDetails,
      ...trendingItems.filter(v => !fetchedDetails.find(f => f.id === v.id)),
    ];

    // Step 7 — filter
    const maxSeconds  = settings.maxDurationMinutes * 60;
    const watchedIds  = await getWatchedIds();
    const excludedSet = new Set(excludedIds);

    const filtered = allDetails.filter(v => {
      const dur = parseDurationToSeconds(v.contentDetails?.duration);
      if (dur <= 0 || dur > maxSeconds) return false;
      if (isShort(v))            return false;
      if (watchedIds.has(v.id))  return false;
      if (excludedSet.has(v.id)) return false;
      return true;
    });

    // Step 8 — score, sort, slice
    const videos = filtered
      .map(v => ({
        id:              v.id,
        title:           v.snippet.title,
        channel:         v.snippet.channelTitle,
        thumbnail:       v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
        duration:        formatDuration(v.contentDetails.duration),
        durationSeconds: parseDurationToSeconds(v.contentDetails.duration),
        publishedAt:     v.snippet.publishedAt,
        score:           engagementScore(v.statistics, v.snippet.publishedAt),
        views:           formatViewCount(v.statistics?.viewCount),
        // 'trending' = from mostPopular chart | 'subscription' = from subscribed channel
        source:          trendingIds.has(v.id) ? 'trending' : 'subscription',
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, settings.videoCount);

    await setCachedVideos(videos, null, excludedIds);
    return videos;

  } catch (err) {
    const reason =
      err.message?.includes('403')   ? 'youtube_api_disabled' :
      err.message?.includes('token') ? 'not_authenticated'    :
      err.message?.includes('OAuth') ? 'not_authenticated'    :
      'unknown';
    console.warn('LunchTube API error:', err.message);
    await setCachedVideos([], reason, excludedIds);
    return [];
  }
}

async function refreshIfLunchTime() {
  const { settings } = await chrome.storage.sync.get({ settings: DEFAULT_SETTINGS });
  if (!isLunchTime(settings)) return;
  const cached = await getCachedVideos();
  if (!cached) await fetchAndCacheVideos(settings);
}

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'GET_STATE')       { handleGetState().then(sendResponse);                                       return true; }
  if (request.type === 'REFRESH_VIDEOS')  { handleRefresh().then(sendResponse);                                        return true; }
  if (request.type === 'AUTH_INTERACTIVE'){ handleInteractiveAuth().then(sendResponse);                                return true; }
  if (request.type === 'MARK_WATCHED')    { markVideoWatched(request.videoId).then(() => sendResponse({ ok: true }));  return true; }
});

async function handleGetState() {
  const { settings } = await chrome.storage.sync.get({ settings: DEFAULT_SETTINGS });

  if (!isLunchTime(settings)) {
    return { state: 'waiting', minutesUntil: minutesUntilLunch(settings), settings };
  }

  const remainingRefreshes = await getRemainingRefreshes(settings);
  const { videoCache }     = await chrome.storage.local.get('videoCache');

  if (videoCache?.videos?.length) {
    return { state: 'lunch', videos: videoCache.videos, apiError: videoCache.apiError, remainingRefreshes, settings };
  }

  const videos    = await fetchAndCacheVideos(settings);
  const { videoCache: vc2 } = await chrome.storage.local.get('videoCache');
  const remaining = await getRemainingRefreshes(settings);
  return { state: 'lunch', videos, apiError: vc2?.apiError, remainingRefreshes: remaining, settings };
}

async function handleRefresh() {
  const { settings } = await chrome.storage.sync.get({ settings: DEFAULT_SETTINGS });
  const remaining    = await getRemainingRefreshes(settings);

  if (remaining <= 0) {
    const { videoCache } = await chrome.storage.local.get('videoCache');
    return {
      videos: videoCache?.videos || [],
      apiError: videoCache?.apiError,
      remainingRefreshes: 0,
      refreshLimitReached: true,
    };
  }

  const newRemaining   = await incrementRefresh(settings);
  const { videoCache } = await chrome.storage.local.get('videoCache');
  const shownIds       = videoCache?.shownIds || [];

  // Fetch a completely new set, same videoCount, excluding already-shown IDs
  const videos = await fetchAndCacheVideos(settings, shownIds);
  const { videoCache: vc2 } = await chrome.storage.local.get('videoCache');

  return {
    videos,
    apiError:           vc2?.apiError || null,
    remainingRefreshes: newRemaining,
    refreshLimitReached: newRemaining <= 0,
  };
}

async function handleInteractiveAuth() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError || !token) resolve({ success: false, error: chrome.runtime.lastError?.message });
      else resolve({ success: true });
    });
  });
}