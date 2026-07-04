const TOKEN_TTL_SECONDS = 60 * 60 * 6;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');

  try {
    if (route === 'login' && request.method === 'POST') return await handleLogin(request, env);
    if (route === 'verify' && request.method === 'GET') return await handleVerify(request, env);
    if (route === 'upload-image' && request.method === 'POST') return await handleUploadImage(request, env);
    if (route === 'create-post' && request.method === 'POST') return await handleCreatePost(request, env);
    return json({ ok: false, message: '지원하지 않는 API 경로입니다.' }, 404);
  } catch (error) {
    return json({ ok: false, message: error.message || '서버 처리 중 오류가 발생했습니다.' }, 500);
  }
}

async function handleLogin(request, env) {
  requireEnv(env, ['ADMIN_PASSWORD', 'ADMIN_TOKEN_SECRET']);
  const body = await safeJson(request);
  const password = String(body.password || '');
  if (!constantTimeEqual(password, env.ADMIN_PASSWORD)) {
    return json({ ok: false, message: '비밀번호가 맞지 않습니다.' }, 401);
  }
  const token = await createToken(env.ADMIN_TOKEN_SECRET);
  return json({ ok: true, token });
}

async function handleVerify(request, env) {
  requireEnv(env, ['ADMIN_TOKEN_SECRET']);
  await requireAuth(request, env);
  return json({ ok: true });
}

async function handleUploadImage(request, env) {
  requireEnv(env, ['ADMIN_TOKEN_SECRET', 'GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_BRANCH', 'SITE_URL']);
  await requireAuth(request, env);

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return json({ ok: false, message: '이미지 파일이 없습니다.' }, 400);
  }

  const form = await request.formData();
  const file = form.get('image');
  if (!file || typeof file === 'string') return json({ ok: false, message: '이미지 파일이 없습니다.' }, 400);
  if (!String(file.type || '').startsWith('image/')) return json({ ok: false, message: '이미지 파일만 업로드할 수 있습니다.' }, 400);
  if (file.size > MAX_IMAGE_SIZE) return json({ ok: false, message: '이미지는 5MB 이하로 올려주세요.' }, 400);

  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  if (file.type !== 'image/webp') return json({ ok: false, message: '이미지는 WebP로 변환된 파일만 저장할 수 있습니다.' }, 400);
  const baseName = safeFileName(file.name.replace(/\.[^.]+$/, '')) || 'image';
  const path = `uploads/${yyyy}/${mm}/${Date.now()}-${baseName}.webp`;
  const contentBase64 = arrayBufferToBase64(await file.arrayBuffer());

  await commitFiles(env, `upload image ${path}`, [
    { path, content: contentBase64, encoding: 'base64' }
  ]);

  return json({
    ok: true,
    path,
    url: `${trimSlash(env.SITE_URL)}/${path}`,
    alt: file.name.replace(/\.[^.]+$/, '')
  });
}

async function handleCreatePost(request, env) {
  requireEnv(env, ['ADMIN_TOKEN_SECRET', 'GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_BRANCH', 'SITE_URL']);
  await requireAuth(request, env);

  const body = await safeJson(request);
  const title = cleanText(body.title || '').slice(0, 90);
  const rawContent = String(body.contentHtml || '');
  if (!title) return json({ ok: false, message: '제목이 비어 있습니다.' }, 400);
  if (!rawContent.trim()) return json({ ok: false, message: '내용이 비어 있습니다.' }, 400);

  const contentHtml = sanitizeAdminHtml(rawContent);
  const posts = await loadPosts(env);
  const nextId = Math.max(1000, ...posts.map((post) => Number(post.id) || 0)) + 1;
  const createdAt = new Date().toISOString();
  const slug = `ab-qna_v-${nextId}.html`;
  const path = `ab-qna/${slug}`;
  const excerpt = createExcerpt(contentHtml, 135);
  const newPost = { id: nextId, title, slug, path, createdAt, excerpt, searchText: stripTags(contentHtml) };
  const nextPosts = [newPost, ...posts].sort((a, b) => Number(b.id) - Number(a.id));

  const files = [
    { path: 'data/posts.json', content: JSON.stringify(nextPosts, null, 2), encoding: 'utf-8' },
    { path, content: renderPostPage(env, newPost, contentHtml, nextPosts), encoding: 'utf-8' },
    { path: 'ab-qna/index.html', content: renderListPage(env, nextPosts), encoding: 'utf-8' },
    { path: 'index.html', content: renderHomePage(env, nextPosts), encoding: 'utf-8' },
    { path: 'sitemap.xml', content: renderSitemap(env, nextPosts), encoding: 'utf-8' },
    { path: 'rss.xml', content: renderRss(env, nextPosts), encoding: 'utf-8' }
  ];

  await commitFiles(env, `create post ${nextId}: ${title}`, files);

  return json({
    ok: true,
    id: nextId,
    title,
    slug,
    path,
    createdAt,
    excerpt,
    searchText: newPost.searchText,
    url: `${trimSlash(env.SITE_URL)}/${path}`
  });
}

async function safeJson(request) {
  try { return await request.json(); } catch (_) { return {}; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function requireEnv(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Cloudflare 환경 변수가 없습니다: ${missing.join(', ')}`);
}

async function createToken(secret) {
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    scope: 'notice-admin'
  };
  const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmac(payloadEncoded, secret);
  return `${payloadEncoded}.${signature}`;
}

async function verifyToken(token, secret) {
  if (!token || !token.includes('.')) return false;
  const [payloadEncoded, signature] = token.split('.');
  const expected = await hmac(payloadEncoded, secret);
  if (!constantTimeEqual(signature, expected)) return false;
  let payload;
  try { payload = JSON.parse(base64UrlDecode(payloadEncoded)); } catch (_) { return false; }
  return payload.scope === 'notice-admin' && Number(payload.exp) > Math.floor(Date.now() / 1000);
}

async function requireAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const ok = await verifyToken(token, env.ADMIN_TOKEN_SECRET);
  if (!ok) throw new Error('관리자 인증이 필요합니다. 다시 비밀번호를 입력하세요.');
}

async function hmac(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}
function base64UrlEncodeBytes(bytes) {
  let binary = '';
  bytes.forEach((byte) => binary += String.fromCharCode(byte));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function base64UrlDecode(value) {
  value = value.replace(/-/g, '+').replace(/_/g, '/');
  while (value.length % 4) value += '=';
  return base64ToUtf8(value);
}


function constantTimeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function imageExtension(name, mime) {
  const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  return map[mime] || 'jpg';
}

function safeFileName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9가-힣_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

async function githubFetch(env, path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'notice-life-helper-board',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) {
    const message = data && data.message ? data.message : text;
    throw new Error(`GitHub API 오류: ${message}`);
  }
  return data;
}

async function loadPosts(env) {
  try {
    const data = await githubFetch(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/data/posts.json?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`);
    const jsonText = decodeBase64Content(data.content || '');
    const posts = JSON.parse(jsonText);
    return Array.isArray(posts) ? posts : [];
  } catch (_) {
    return [];
  }
}

function decodeBase64Content(value) {
  return base64ToUtf8(String(value).replace(/\s/g, ''));
}

function base64ToUtf8(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function commitFiles(env, message, files) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const owner = env.GITHUB_OWNER;
      const repo = env.GITHUB_REPO;
      const branch = env.GITHUB_BRANCH;
      const ref = await githubFetch(env, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      const latestCommitSha = ref.object.sha;
      const latestCommit = await githubFetch(env, `/repos/${owner}/${repo}/git/commits/${latestCommitSha}`);
      const baseTreeSha = latestCommit.tree.sha;

      const tree = [];
      for (const file of files) {
        const blob = await githubFetch(env, `/repos/${owner}/${repo}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: file.content, encoding: file.encoding || 'utf-8' })
        });
        tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
      }

      const newTree = await githubFetch(env, `/repos/${owner}/${repo}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({ base_tree: baseTreeSha, tree })
      });
      const newCommit = await githubFetch(env, `/repos/${owner}/${repo}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({ message, tree: newTree.sha, parents: [latestCommitSha] })
      });
      await githubFetch(env, `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: newCommit.sha })
      });
      return;
    } catch (error) {
      if (attempt === 0 && /Reference update failed|Update is not a fast forward|409/i.test(error.message)) continue;
      throw error;
    }
  }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sanitizeAdminHtml(html) {
  let out = String(html || '');
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style[\s\S]*?<\/style>/gi, '');
  out = out.replace(/\son\w+=("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/javascript:/gi, '');
  out = out.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  return out;
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function createExcerpt(html, max) {
  const text = stripTags(html);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function trimSlash(value) {
  return String(value || '').replace(/\/$/, '');
}

function displayDate(value) {
  try {
    const d = new Date(value);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
  } catch (_) { return String(value).slice(0, 10); }
}

function absoluteUrl(env, value) {
  const site = trimSlash(env.SITE_URL);
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  return site + (v.startsWith('/') ? v : '/' + v);
}

function extractFirstImageUrl(env, html) {
  const match = String(html || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? absoluteUrl(env, match[1]) : '';
}

function createArticleJsonLd(env, post) {
  const url = `${trimSlash(env.SITE_URL)}/${post.path}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.excerpt || '',
    datePublished: post.createdAt || '',
    dateModified: post.updatedAt || post.createdAt || '',
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    url,
    author: { '@type': 'Organization', name: '올딜 생활게시판' },
    publisher: { '@type': 'Organization', name: '올딜 생활게시판' }
  };
}

function renderArticleNav(posts, currentPost) {
  const sorted = posts.slice().sort((a, b) => Number(a.id) - Number(b.id));
  const index = sorted.findIndex((post) => Number(post.id) === Number(currentPost.id));
  const prev = index > 0 ? sorted[index - 1] : null;
  const next = index >= 0 && index < sorted.length - 1 ? sorted[index + 1] : null;
  const link = (className, label, post) => post
    ? `<a class="post-nav-link ${className}" href="/${escapeHtml(post.path)}"><span>${label}</span><strong>${escapeHtml(post.title)}</strong></a>`
    : `<span class="post-nav-link ${className} disabled"><span>${label}</span><strong>글이 없습니다</strong></span>`;
  return `      <nav class="post-nav" aria-label="이전글 다음글">
        ${link('prev', '이전글', prev)}
        ${link('next', '다음글', next)}
      </nav>`;
}

function layout(env, title, description, body, canonicalPath = '/', options = {}) {
  const site = trimSlash(env.SITE_URL);
  const canonicalUrl = site + canonicalPath;
  const ogType = options.ogType || 'website';
  const ogImage = options.ogImage ? `
  <meta property="og:image" content="${escapeHtml(options.ogImage)}">
  <meta name="twitter:image" content="${escapeHtml(options.ogImage)}">` : '';
  const articleMeta = options.publishedTime ? `
  <meta property="article:published_time" content="${escapeHtml(options.publishedTime)}">
  <meta property="article:modified_time" content="${escapeHtml(options.modifiedTime || options.publishedTime)}">` : '';
  const jsonLd = options.jsonLd ? `
  <script type="application/ld+json">${safeScriptJson(options.jsonLd)}</script>` : '';
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:locale" content="ko_KR">
  <meta property="og:site_name" content="올딜 생활게시판">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:type" content="${escapeHtml(ogType)}">${ogImage}${articleMeta}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <link rel="stylesheet" href="/assets/style.css">${jsonLd}
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <a class="logo" href="/"><span class="logo-badge">올</span><span>올딜 생활게시판</span></a>
      <h1 class="hero-title">생활 서비스 문의와 안내를 모아둔 게시판</h1>
      <p class="hero-desc">포장이사, 인터넷가입, 이사청소처럼 비교가 필요한 생활 정보를 게시판 형식으로 정리합니다.</p>
      <nav class="nav">
        <a href="/">홈</a>
        <a href="/ab-qna/">게시판</a>
        <a href="/admin/password.html">글쓰기</a>
      </nav>
    </div>
  </header>
  <main class="container">
${body}
  </main>
  <footer class="footer">© 올딜 생활게시판</footer>
</body>
</html>`;
}

function renderRows(posts) {
  return posts.map((post) => `      <div class="board-row">
        <div class="board-no">${post.id}</div>
        <a class="board-title" href="/${post.path}">${escapeHtml(post.title)}</a>
        <div class="board-date">${displayDate(post.createdAt)}</div>
      </div>`).join('\n');
}

function safeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function renderBoardScript(posts) {
  return `<script>
(function(){
  var posts = ${safeScriptJson(posts)};

  function mergePendingPosts(basePosts) {
    var base = Array.isArray(basePosts) ? basePosts.slice() : [];
    var originalKeys = {};
    base.forEach(function(post) {
      originalKeys[String(post.id || post.path)] = true;
    });
    var pending = [];
    try {
      pending = JSON.parse(localStorage.getItem('notice_pending_posts') || '[]');
      if (!Array.isArray(pending)) pending = [];
    } catch (_) { pending = []; }
    var now = Date.now();
    var stillPending = [];
    pending.forEach(function(post) {
      if (!post || !post.path) return;
      var key = String(post.id || post.path);
      var savedAt = Number(post.savedAtMs || 0);
      var expired = savedAt && (now - savedAt > 24 * 60 * 60 * 1000);
      if (expired) return;
      if (originalKeys[key]) return;
      originalKeys[key] = true;
      stillPending.push(post);
      base.unshift(post);
    });
    try {
      if (stillPending.length) localStorage.setItem('notice_pending_posts', JSON.stringify(stillPending.slice(0, 20)));
      else localStorage.removeItem('notice_pending_posts');
    } catch (_) {}
    return base.sort(function(a, b) {
      var aid = Number(a.id) || 0;
      var bid = Number(b.id) || 0;
      if (aid !== bid) return bid - aid;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
  }
  posts = mergePendingPosts(posts);
  var perPage = 10;
  var currentPage = 1;
  var currentQuery = '';
  var list = document.getElementById('boardList');
  var pagination = document.getElementById('boardPagination');
  var empty = document.getElementById('boardEmpty');
  var form = document.getElementById('boardSearchForm');
  var input = document.getElementById('boardSearchInput');

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>\"']/g, function(ch) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch] || ch;
    });
  }
  function displayDate(value) {
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value || '').slice(0, 10);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '.' + m + '.' + day;
  }
  function normalize(value) {
    return String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
  }
  function filteredPosts() {
    var q = normalize(currentQuery);
    if (!q) return posts.slice();
    return posts.filter(function(post) {
      var target = normalize([post.id, post.title, post.excerpt, post.searchText].join(' '));
      return target.indexOf(q) !== -1;
    });
  }
  function renderRows(rows) {
    if (!rows.length) {
      list.innerHTML = '';
      empty.classList.add('active');
      return;
    }
    empty.classList.remove('active');
    list.innerHTML = rows.map(function(post) {
      return '<div class="board-row">' +
        '<div class="board-no">' + escapeHtml(post.id) + '</div>' +
        '<a class="board-title" href="/' + escapeHtml(post.path) + '">' + escapeHtml(post.title) + '</a>' +
        '<div class="board-date">' + displayDate(post.createdAt) + '</div>' +
      '</div>';
    }).join('');
  }
  function pageButton(label, page, active, disabled) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'page-btn' + (active ? ' active' : '');
    btn.textContent = label;
    btn.disabled = !!disabled;
    if (!disabled) btn.addEventListener('click', function(){ currentPage = page; render(true); });
    return btn;
  }
  function renderPagination(totalPages) {
    pagination.innerHTML = '';
    if (totalPages <= 1) return;
    var blockStart = Math.floor((currentPage - 1) / 10) * 10 + 1;
    var blockEnd = Math.min(blockStart + 9, totalPages);
    pagination.appendChild(pageButton('‹', Math.max(1, blockStart - 10), false, blockStart === 1));
    for (var i = blockStart; i <= blockEnd; i++) {
      pagination.appendChild(pageButton(String(i), i, i === currentPage, false));
    }
    pagination.appendChild(pageButton('›', Math.min(totalPages, blockStart + 10), false, blockEnd >= totalPages));
  }
  function updateUrl() {
    var params = new URLSearchParams();
    if (currentQuery) params.set('q', currentQuery);
    if (currentPage > 1) params.set('page', String(currentPage));
    var qs = params.toString();
    history.replaceState({ q: currentQuery, page: currentPage }, '', qs ? '/ab-qna/?' + qs : '/ab-qna/');
  }
  function render(syncUrl) {
    var filtered = filteredPosts();
    var totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
    currentPage = Math.max(1, Math.min(currentPage, totalPages));
    var start = (currentPage - 1) * perPage;
    renderRows(filtered.slice(start, start + perPage));
    renderPagination(totalPages);
    if (syncUrl) updateUrl();
  }
  function loadFromUrl() {
    var params = new URLSearchParams(location.search);
    currentQuery = params.get('q') || '';
    currentPage = Math.max(1, parseInt(params.get('page') || '1', 10) || 1);
    input.value = currentQuery;
    render(false);
  }
  form.addEventListener('submit', function(event) {
    event.preventDefault();
    currentQuery = input.value.trim();
    currentPage = 1;
    render(true);
  });
  window.addEventListener('popstate', loadFromUrl);
  loadFromUrl();
})();
<\/script>`;
}

function renderListPage(env, posts) {
  const body = `    <section class="card post-wrap">
      <div class="board-toolbar">
        <div>
          <h2 class="section-title">최근 게시글</h2>
          <p style="margin:0;color:var(--muted)">새 글은 관리자 비밀번호 확인 후 작성할 수 있습니다.</p>
        </div>
        <a class="btn btn-primary" href="/admin/password.html">글쓰기</a>
      </div>
      <form id="boardSearchForm" class="board-search" role="search">
        <input id="boardSearchInput" type="search" placeholder="검색어를 입력해주세요" autocomplete="off">
        <button class="search-btn" type="submit" aria-label="검색">검색</button>
      </form>
      <div id="boardList" class="board-list">
${renderRows(posts.slice(0, 10))}
      </div>
      <div id="boardEmpty" class="board-empty">검색 결과가 없습니다.</div>
      <div id="boardPagination" class="pagination" aria-label="페이지 이동"></div>
${renderBoardScript(posts)}
    </section>`;
  return layout(env, '올딜 생활게시판 목록', '올딜 생활게시판의 최신 게시글 목록입니다.', body, '/ab-qna/');
}

function renderHomePage(env, posts) {
  const body = `    <section class="card post-wrap">
      <div class="board-toolbar">
        <div>
          <h2 class="section-title">최근 게시글</h2>
          <p style="margin:0;color:var(--muted)">생활 서비스 관련 글을 게시판 형식으로 확인할 수 있습니다.</p>
        </div>
        <a class="btn btn-primary" href="/admin/password.html">글쓰기</a>
      </div>
      <div class="board-list">
${renderRows(posts.slice(0, 20))}
      </div>
    </section>`;
  return layout(env, '올딜 생활게시판', '생활 서비스 문의와 안내를 모아둔 올딜 생활게시판입니다.', body, '/');
}

function renderPostPage(env, post, contentHtml, posts = []) {
  const body = `    <article class="card post-wrap">
      <h1 class="post-title">${escapeHtml(post.title)}</h1>
      <div class="post-meta">작성자 관리자 · <time datetime="${escapeHtml(post.createdAt)}">작성일 ${displayDate(post.createdAt)}</time></div>
      <div class="post-content">
${contentHtml}
      </div>
${renderArticleNav(posts, post)}
      <p style="margin-top:28px"><a class="btn btn-light" href="/ab-qna/">목록으로</a></p>
    </article>`;
  return layout(env, post.title, post.excerpt, body, `/${post.path}`, {
    ogType: 'article',
    ogImage: extractFirstImageUrl(env, contentHtml),
    publishedTime: post.createdAt,
    modifiedTime: post.updatedAt || post.createdAt,
    jsonLd: createArticleJsonLd(env, post)
  });
}

function renderSitemap(env, posts) {
  const site = trimSlash(env.SITE_URL);
  const base = [
    { loc: `${site}/`, changefreq: 'daily', priority: '0.8', lastmod: new Date().toISOString().slice(0, 10) },
    { loc: `${site}/ab-qna/`, changefreq: 'hourly', priority: '0.9', lastmod: new Date().toISOString().slice(0, 10) }
  ];
  const urls = base.concat(posts.map((post) => ({ loc: `${site}/${post.path}`, changefreq: 'weekly', priority: '0.7', lastmod: String(post.updatedAt || post.createdAt || '').slice(0, 10) })));
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url>
    <loc>${escapeHtml(url.loc)}</loc>
    ${url.lastmod ? `<lastmod>${escapeHtml(url.lastmod)}</lastmod>\n    ` : ''}<changefreq>${url.changefreq}</changefreq>
    <priority>${url.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;
}

function renderRss(env, posts) {
  const site = trimSlash(env.SITE_URL);
  const items = posts.slice(0, 30).map((post) => `    <item>
      <title>${escapeHtml(post.title)}</title>
      <link>${site}/${post.path}</link>
      <guid>${site}/${post.path}</guid>
      <pubDate>${new Date(post.createdAt).toUTCString()}</pubDate>
      <description>${escapeHtml(post.excerpt)}</description>
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>올딜 생활게시판</title>
    <link>${site}/ab-qna/</link>
    <description>생활 서비스 게시글 RSS</description>
${items}
  </channel>
</rss>
`;
}
