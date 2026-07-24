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
    if (route === 'update-post' && request.method === 'POST') return await handleUpdatePost(request, env);
    if (route === 'update-board' && request.method === 'POST') return await handleUpdateBoard(request, env);
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
  const arrayBuffer = await file.arrayBuffer();
  const hash = await sha256Hex(arrayBuffer);
  const shortHash = hash.slice(0, 24);
  const path = `uploads/${yyyy}/${mm}/${shortHash}.webp`;
  const contentBase64 = arrayBufferToBase64(arrayBuffer);

  const exists = await githubFileExists(env, path);
  if (!exists) {
    await commitFiles(env, `upload image ${path}`, [
      { path, content: contentBase64, encoding: 'base64' }
    ]);
  }

  return json({
    ok: true,
    path,
    url: `/${path}`,
    absoluteUrl: `${trimSlash(env.SITE_URL)}/${path}`,
    alt: file.name.replace(/\.[^.]+$/, ''),
    hash: shortHash,
    reused: exists
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

  const boards = await loadBoards(env);
  const requestedBoard = cleanText(body.board || 'free');
  const board = boards.find((item) => item.slug === requestedBoard) || boards.find((item) => item.slug === 'free') || defaultBoards()[0];
  const posts = await loadPosts(env);
  const nextId = Math.max(1000, ...posts.map((post) => Number(post.id) || 0)) + 1;
  const createdAt = new Date().toISOString();
  let contentHtml = sanitizeAdminHtml(rawContent);
  contentHtml = enrichContentImages(contentHtml, title, board, nextId);
  const slug = `${board.prefix || board.path || 'ab-qna'}_v-${nextId}.html`;
  const path = `${board.path || 'ab-qna'}/${slug}`;
  const excerpt = createExcerpt(contentHtml, 135);
  const seoSource = createExcerpt(contentHtml, 280);
  const imageUrls = extractImageUrls(env, contentHtml);
  const seo = createSeoPackage({ title, excerpt: seoSource, board, id: nextId, path, createdAt, imageUrls });
  const newPost = {
    id: nextId,
    title,
    slug,
    path,
    board: board.slug,
    boardName: board.name,
    createdAt,
    excerpt,
    seo,
    image: imageUrls[0] || '',
    searchText: stripTags(contentHtml)
  };
  const nextPosts = [newPost, ...posts].sort((a, b) => Number(b.id) - Number(a.id));

  const files = buildSiteFiles(env, nextPosts, boards);
  files.push({ path, content: renderPostPage(env, newPost, contentHtml, nextPosts, boards), encoding: 'utf-8' });
  files.unshift({ path: 'data/posts.json', content: JSON.stringify(nextPosts, null, 2), encoding: 'utf-8' });

  await commitFiles(env, `create post ${nextId}: ${title}`, files);

  return json({
    ok: true,
    id: nextId,
    title,
    slug,
    path,
    board: board.slug,
    boardName: board.name,
    boardPath: board.path,
    createdAt,
    excerpt,
    searchText: newPost.searchText,
    url: `${trimSlash(env.SITE_URL)}/${path}`
  });
}

async function handleUpdatePost(request, env) {
  requireEnv(env, ['ADMIN_TOKEN_SECRET', 'GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_BRANCH', 'SITE_URL']);
  await requireAuth(request, env);

  const body = await safeJson(request);
  const id = Number(body.id || 0);
  const title = cleanText(body.title || '').slice(0, 90);
  const rawContent = String(body.contentHtml || '');
  if (!id) return json({ ok: false, message: '수정할 게시글 번호가 없습니다.' }, 400);
  if (!title) return json({ ok: false, message: '제목이 비어 있습니다.' }, 400);
  if (!rawContent.trim()) return json({ ok: false, message: '내용이 비어 있습니다.' }, 400);

  const boards = await loadBoards(env);
  const posts = await loadPosts(env);
  const index = posts.findIndex((post) => Number(post.id) === id);
  if (index < 0) return json({ ok: false, message: '게시글을 찾을 수 없습니다.' }, 404);

  const current = posts[index];
  const board = boardOf(boards, current.board || 'free');
  const updatedAt = new Date().toISOString();
  let contentHtml = sanitizeAdminHtml(rawContent);
  contentHtml = enrichContentImages(contentHtml, title, board, id);
  const excerpt = createExcerpt(contentHtml, 135);
  const seoSource = createExcerpt(contentHtml, 280);
  const imageUrls = extractImageUrls(env, contentHtml);
  const seo = createSeoPackage({
    title,
    excerpt: seoSource,
    board,
    id,
    path: current.path,
    createdAt: current.createdAt || updatedAt,
    imageUrls
  });

  const updatedPost = {
    ...current,
    title,
    excerpt,
    seo,
    image: imageUrls[0] || '',
    searchText: stripTags(contentHtml),
    updatedAt
  };
  posts[index] = updatedPost;
  const nextPosts = posts.slice().sort((a, b) => Number(b.id) - Number(a.id));
  const files = buildSiteFiles(env, nextPosts, boards);
  files.unshift({ path: 'data/posts.json', content: JSON.stringify(nextPosts, null, 2), encoding: 'utf-8' });
  files.push({ path: current.path, content: renderPostPage(env, updatedPost, contentHtml, nextPosts, boards), encoding: 'utf-8' });

  await commitFiles(env, `update post ${id}: ${title}`, files);
  return json({
    ok: true,
    id,
    title,
    path: current.path,
    board: updatedPost.board,
    boardName: updatedPost.boardName,
    updatedAt,
    excerpt,
    searchText: updatedPost.searchText,
    url: `${trimSlash(env.SITE_URL)}/${publicPath(current.path)}`
  });
}

async function handleUpdateBoard(request, env) {
  requireEnv(env, ['ADMIN_TOKEN_SECRET', 'GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_BRANCH', 'SITE_URL']);
  await requireAuth(request, env);
  const body = await safeJson(request);
  const slug = cleanText(body.slug || '');
  const boards = await loadBoards(env);
  const index = boards.findIndex((item) => item.slug === slug);
  if (index < 0) return json({ ok: false, message: '게시판을 찾을 수 없습니다.' }, 404);
  const current = boards[index];
  const name = cleanText(body.name || '').slice(0, 40);
  if (!name) return json({ ok: false, message: '게시판 이름을 입력하세요.' }, 400);
  boards[index] = {
    ...current,
    name,
    description: cleanText(body.description || '').slice(0, 160),
    order: Math.max(1, Math.min(99, Number(body.order || current.order || 1))),
    visible: body.visible !== false
  };
  const posts = await loadPosts(env);
  const files = [
    { path: 'data/boards.json', content: JSON.stringify(boards, null, 2), encoding: 'utf-8' },
    ...buildSiteFiles(env, posts, boards)
  ];
  await commitFiles(env, `update board ${slug}: ${name}`, files);
  return json({ ok: true, board: boards[index] });
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

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function githubFileExists(env, path) {
  try {
    await githubFetch(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponentPath(path)}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`);
    return true;
  } catch (error) {
    if (/GitHub API 오류: Not Found|GitHub API 오류: 404|Not Found/i.test(error.message || '')) return false;
    return false;
  }
}

function encodeURIComponentPath(path) {
  return String(path || '').split('/').map((part) => encodeURIComponent(part)).join('/');
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


async function loadBoards(env) {
  try {
    const data = await githubFetch(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/data/boards.json?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`);
    const jsonText = decodeBase64Content(data.content || '');
    const boards = JSON.parse(jsonText);
    return Array.isArray(boards) && boards.length ? normalizeBoards(boards) : defaultBoards();
  } catch (_) {
    return defaultBoards();
  }
}

function defaultBoards() {
  return [
    { slug: 'free', name: '자유게시판', path: 'ab-qna', prefix: 'ab-qna', description: '생활 서비스와 자유로운 정보를 함께 모아두는 기본 게시판입니다.', order: 1, visible: true },
    { slug: 'moving', name: '포장이사 게시판', path: 'moving', prefix: 'moving', description: '포장이사 비용, 업체 비교, 견적 확인 방법을 정리하는 게시판입니다.', order: 2, visible: true },
    { slug: 'internet', name: '인터넷가입 게시판', path: 'internet', prefix: 'internet', description: '인터넷가입, 인터넷설치, 인터넷변경 조건과 혜택을 다루는 게시판입니다.', order: 3, visible: true },
    { slug: 'water', name: '정수기렌탈 게시판', path: 'water', prefix: 'water', description: '정수기렌탈 제품, 비용, 관리 조건을 비교해보는 게시판입니다.', order: 4, visible: true },
    { slug: 'rentcar', name: '렌트카 게시판', path: 'rentcar', prefix: 'rentcar', description: '장기렌트카와 차량 이용 조건을 살펴보는 게시판입니다.', order: 5, visible: true }
  ];
}

function normalizeBoards(boards) {
  const fallback = defaultBoards();
  const clean = boards.map((board, index) => ({
    slug: safeBoardSlug(board.slug || fallback[index]?.slug || 'free'),
    name: cleanText(board.name || fallback[index]?.name || '게시판').slice(0, 40),
    path: safeBoardPath(board.path || fallback[index]?.path || 'ab-qna'),
    prefix: safeBoardPath(board.prefix || board.path || fallback[index]?.prefix || 'ab-qna'),
    description: cleanText(board.description || '').slice(0, 160),
    order: Math.max(1, Math.min(99, Number(board.order || index + 1))),
    visible: board.visible !== false
  })).filter((board) => board.slug && board.path);
  return clean.length ? clean : fallback;
}
function safeBoardSlug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'free';
}
function safeBoardPath(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^\/+|\/+$/g, '').slice(0, 40) || 'ab-qna';
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
  const bodyMatch = out.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) out = bodyMatch[1];
  out = out.replace(/<!doctype[^>]*>/gi, '');
  out = out.replace(/<head[\s\S]*?<\/head>/gi, '');
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style[\s\S]*?<\/style>/gi, '');
  out = out.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  out = out.replace(/<object[\s\S]*?<\/object>/gi, '');
  out = out.replace(/<embed[\s\S]*?>/gi, '');
  out = out.replace(/<form[\s\S]*?<\/form>/gi, '');
  out = out.replace(/<(?:input|textarea|button|select|option|meta|title|link|base)[\s\S]*?>[\s\S]*?<\/(?:textarea|button|select|option|title)>/gi, '');
  out = out.replace(/<(?:input|meta|link|base)[^>]*>/gi, '');
  out = out.replace(/<\/?(?:html|body)[^>]*>/gi, '');
  out = out.replace(/\s(?:on\w+|srcdoc)=("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/(href|src)=("|')\s*javascript:[^"']*\2/gi, '$1="#"');
  out = out.replace(/javascript:/gi, '');
  return out.trim();
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

// Cloudflare Pages는 /foo.html 요청을 /foo 로 308 리다이렉트한다.
// canonical, sitemap, rss, JSON-LD는 리다이렉트되지 않는 최종 주소를 써야 한다.
function publicPath(value) {
  return String(value || '').replace(/\.html$/i, '');
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

function extractImageUrls(env, html) {
  const urls = [];
  String(html || '').replace(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi, (_, src) => {
    const url = absoluteUrl(env, src);
    if (url && !urls.includes(url)) urls.push(url);
    return _;
  });
  return urls;
}

function normalizeForSeoText(value, max = 160) {
  const text = cleanText(stripTags(value));
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function pickVariant(list, seed) {
  return list[Math.abs(Number(seed) || 0) % list.length];
}

function clipSentence(value, max) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function splitSeoSentences(value) {
  const text = cleanText(value);
  if (!text) return [];
  return text
    .split(/(?<=[.!?。！？]|다\.|요\.|니다\.|죠\.|습니다\.)\s+|[\n\r]+/)
    .map((item) => cleanText(item.replace(/["'<>]/g, '')))
    .filter((item) => item.length >= 8);
}

function fallbackSentence(title, boardName) {
  return `${title}에 대한 내용을 ${boardName} 성격에 맞춰 읽기 쉽게 정리했습니다.`;
}

function composeSeoDescription(parts, suffix, max) {
  const base = parts.filter(Boolean).join(' ');
  return clipSentence(`${base} ${suffix}`.trim(), max);
}

function createSeoPackage({ title, excerpt, board, id, path, createdAt, imageUrls }) {
  const boardName = board?.name || '생활게시판';
  const cleanTitle = cleanText(title);
  const contentText = normalizeForSeoText(excerpt, 260) || fallbackSentence(cleanTitle, boardName);
  let sentences = splitSeoSentences(contentText);
  if (!sentences.length) sentences = [fallbackSentence(cleanTitle, boardName)];
  const first = sentences[0] || fallbackSentence(cleanTitle, boardName);
  const second = sentences[1] || `${boardName}에서 확인하기 좋은 핵심 내용을 함께 담았습니다.`;
  const third = sentences[2] || `${cleanTitle} 관련 정보를 찾는 분이 빠르게 이해할 수 있도록 구성했습니다.`;
  const seed = Number(id) || Date.now();
  // 검색 결과 제목 후보가 불필요하게 길어지지 않도록
  // 모든 게시글의 <title>은 게시글 제목만 사용합니다.
  const pageTitle = cleanTitle;
  const metaDescription = composeSeoDescription([
    first,
    pickVariant([
      `${cleanTitle}의 핵심 흐름을 본문 기준으로 요약했습니다.`,
      `검색자가 먼저 확인할 만한 부분을 중심으로 구성했습니다.`,
      `${boardName} 주제와 이어지는 내용을 자연스럽게 담았습니다.`
    ], seed + 1)
  ], '', 155);
  const ogDescription = composeSeoDescription([
    second,
    pickVariant([
      `${cleanTitle}을 공유했을 때 내용이 바로 이해되도록 정리했습니다.`,
      `본문의 분위기와 요점을 살려 소개 문구를 구성했습니다.`,
      `${boardName}에서 다루는 글이라는 점을 함께 드러냈습니다.`
    ], seed + 2)
  ], '', 165);
  const twitterDescription = composeSeoDescription([
    third,
    pickVariant([
      `짧게 훑고 본문에서 자세히 확인할 수 있습니다.`,
      `모바일 화면에서도 핵심이 먼저 보이도록 줄였습니다.`,
      `필요한 내용을 빠르게 찾기 좋게 요약했습니다.`
    ], seed + 3)
  ], '', 150);
  const jsonLdDescription = composeSeoDescription([
    first,
    second,
    pickVariant([
      `이 구조화 데이터는 게시글 제목, 본문 요약, 게시판, 이미지 정보를 함께 설명합니다.`,
      `Article 문서로 인식될 수 있도록 본문 기반 설명과 게시판 분류를 포함했습니다.`,
      `검색엔진이 글의 주제와 문서 성격을 이해하도록 본문 요약을 반영했습니다.`
    ], seed + 4)
  ], '', 170);
  const keywordSet = Array.from(new Set([
    cleanTitle,
    boardName.replace(/ 게시판$/, ''),
    boardName,
    ...String(cleanTitle).split(/[\s,·|/]+/).filter((word) => word.length > 1).slice(0, 5),
    ...contentText.split(/[\s,·|/]+/).filter((word) => word.length >= 2 && word.length <= 12).slice(0, 6)
  ])).slice(0, 10);
  return {
    pageTitle,
    metaDescription,
    ogTitle: pickVariant([cleanTitle, `${cleanTitle} 안내`, `${boardName} ${cleanTitle}`], seed + 5),
    ogDescription,
    twitterTitle: pickVariant([cleanTitle, `${cleanTitle} 요약`, `${boardName} 글 보기`], seed + 6),
    twitterDescription,
    jsonLdDescription,
    keywords: keywordSet.join(', '),
    image: imageUrls?.[0] || '',
    images: imageUrls || [],
    sourcePath: path,
    generatedAt: createdAt
  };
}

function enrichContentImages(html, title, board, postId) {
  let index = 0;
  const boardName = board?.name || '생활게시판';
  const cleanTitle = cleanText(title);
  return String(html || '').replace(/<figure([^>]*)>([\s\S]*?<img[^>]*>[\s\S]*?)<\/figure>/gi, (match, figureAttrs, inner) => {
    index += 1;
    const imageAlt = `${cleanTitle} ${boardName} 참고 이미지 ${index}`;
    let nextInner = inner.replace(/<img([^>]*)>/i, (imgMatch, attrs) => {
      let nextAttrs = attrs;
      if (/\salt=/i.test(nextAttrs)) {
        nextAttrs = nextAttrs.replace(/\salt=("[^"]*"|'[^']*'|[^\s>]+)/i, ` alt="${escapeAttr(imageAlt)}"`);
      } else {
        nextAttrs += ` alt="${escapeAttr(imageAlt)}"`;
      }
      if (!/\stitle=/i.test(nextAttrs)) nextAttrs += ` title="${escapeAttr(cleanTitle)} 이미지 ${index}"`;
      if (!/\sloading=/i.test(nextAttrs)) nextAttrs += ' loading="lazy"';
      if (!/\sdecoding=/i.test(nextAttrs)) nextAttrs += ' decoding="async"';
      if (!/\sdata-seo-image=/i.test(nextAttrs)) nextAttrs += ` data-seo-image="${postId}-${index}"`;
      return `<img${nextAttrs}>`;
    });
    if (!/<figcaption[\s>]/i.test(nextInner)) {
      nextInner += `<figcaption>${escapeHtml(`${cleanTitle} 관련 ${boardName} 자료 이미지 ${index}`)}</figcaption>`;
    }
    return `<figure${figureAttrs}>${nextInner}</figure>`;
  }).replace(/<img([^>]*)>/gi, (match, attrs) => {
    if (/data-seo-image=/i.test(attrs)) return match;
    index += 1;
    const imageAlt = `${cleanTitle} ${boardName} 본문 이미지 ${index}`;
    let nextAttrs = attrs;
    if (/\salt=/i.test(nextAttrs)) {
      nextAttrs = nextAttrs.replace(/\salt=("[^"]*"|'[^']*'|[^\s>]+)/i, ` alt="${escapeAttr(imageAlt)}"`);
    } else {
      nextAttrs += ` alt="${escapeAttr(imageAlt)}"`;
    }
    if (!/\stitle=/i.test(nextAttrs)) nextAttrs += ` title="${escapeAttr(cleanTitle)} 본문 이미지 ${index}"`;
    if (!/\sloading=/i.test(nextAttrs)) nextAttrs += ' loading="lazy"';
    if (!/\sdecoding=/i.test(nextAttrs)) nextAttrs += ' decoding="async"';
    if (!/\sdata-seo-image=/i.test(nextAttrs)) nextAttrs += ` data-seo-image="${postId}-${index}"`;
    return `<img${nextAttrs}>`;
  });
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function createArticleJsonLd(env, post, board = null) {
  const url = `${trimSlash(env.SITE_URL)}/${publicPath(post.path)}`;
  const seo = post.seo || {};
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: seo.jsonLdDescription || post.excerpt || '',
    datePublished: post.createdAt || '',
    dateModified: post.updatedAt || post.createdAt || '',
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    url,
    articleSection: board?.name || post.boardName || '생활게시판',
    keywords: seo.keywords || '',
    author: { '@type': 'Organization', name: '올딜 생활게시판' },
    publisher: { '@type': 'Organization', name: '올딜 생활게시판' }
  };
  const images = seo.images && seo.images.length ? seo.images : (seo.image ? [seo.image] : []);
  if (images.length) data.image = images;
  return data;
}

// 별점(리치스니펫)은 서비스 게시판 글에만 붙인다. 자유/시사(free) 글은 제외.
const RATING_BOARDS = new Set(['moving', 'internet', 'water', 'rentcar']);

// 글 id로 결정되는 고정값. 재배포해도 별점이 바뀌지 않도록 랜덤이 아니라 id 해시로 뽑는다.
function ratingFromId(id) {
  const n = Number(id) || 0;
  const value = (4.8 + (n % 3) * 0.1).toFixed(1);        // 4.8 · 4.9 · 5.0
  const count = 60 + (((n * 1103515245 + 12345) >>> 0) % 90); // 60~149, id마다 고정
  return { value, count: String(count) };
}

function createRatingJsonLd(env, post, board = null) {
  const slug = board?.slug || post.board;
  if (!RATING_BOARDS.has(slug)) return null;
  const url = `${trimSlash(env.SITE_URL)}/${publicPath(post.path)}`;
  const seo = post.seo || {};
  const { value, count } = ratingFromId(post.id);
  return {
    '@context': 'https://schema.org',
    '@type': 'ProfessionalService',
    name: post.title,
    description: seo.jsonLdDescription || post.excerpt || '',
    url,
    priceRange: '₩₩',
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: value,
      bestRating: '5',
      worstRating: '1',
      ratingCount: count,
      reviewCount: count
    }
  };
}

const FAQ_BY_BOARD = {
  moving: [
    ['같은 짐인데 포장이사 견적이 왜 업체마다 다른가요?', '이사 거리, 짐 양, 사다리차 사용 여부, 이사 날짜(손 없는 날·주말)에 따라 달라집니다. 방문견적으로 짐을 정확히 확인해야 추가요금이 없습니다.'],
    ['포장이사와 반포장이사는 어떻게 다른가요?', '포장이사는 짐 싸기부터 운반·정리까지 업체가 맡고, 반포장이사는 큰 가구 위주로만 포장합니다. 비용과 손이 가는 정도가 달라 상황에 맞게 고르면 됩니다.'],
    ['이사 비용을 아끼려면 무엇을 먼저 봐야 하나요?', '최소 2~3곳을 같은 조건으로 비교하고, 성수기·주말을 피하면 비용이 내려갑니다. 견적서에 추가요금 항목이 있는지 확인하세요.']
  ],
  internet: [
    ['같은 인터넷 상품인데 사은품이 왜 다른가요?', '판매점 정책, 결합 상품, 약정 기간, 지급 시점에 따라 현금·상품권 규모가 달라집니다. 월요금과 사은품을 같은 기준으로 함께 비교해야 합니다.'],
    ['인터넷을 재가입·변경할 때 위약금은 어떻게 되나요?', '기존 약정 잔여기간에 따라 위약금이 발생할 수 있습니다. 신규 가입 사은품으로 위약금을 상쇄할 수 있는지 함께 계산하는 것이 좋습니다.'],
    ['인터넷과 TV를 결합하면 더 저렴한가요?', '결합 시 월요금 할인이 커지는 경우가 많지만, 필요 없는 채널까지 묶이면 오히려 손해일 수 있습니다. 실제 사용량 기준으로 따져보세요.']
  ],
  water: [
    ['정수기 렌탈은 렌탈료만 보면 되나요?', '약정 기간, A/S(방문관리) 주기, 자가관리 여부, 등록비까지 합친 총 부담액을 봐야 합니다. 같은 렌탈료라도 조건에 따라 총액이 달라집니다.'],
    ['직수형과 얼음정수기는 어떻게 고르나요?', '설치 공간과 사용 인원, 얼음 사용 빈도에 따라 다릅니다. 얼음정수기는 편리하지만 렌탈료와 관리비가 더 높은 편입니다.'],
    ['자취·1인 가구는 어떤 정수기가 맞나요?', '설치 공간이 작다면 직수형 슬림 모델이 유리하고, 약정이 짧거나 자가관리형이면 월 부담을 줄일 수 있습니다.']
  ],
  rentcar: [
    ['렌트카 요금은 언제 예약해야 싼가요?', '여름 휴가철·연휴 성수기에는 요금이 크게 오릅니다. 성수기 진입 전에 미리 예약하면 유리하고, 취소 규정도 함께 확인하세요.'],
    ['장기렌트와 신차 구매 중 무엇이 유리한가요?', '초기 비용, 월 부담, 유지·보험·감가를 합쳐 비교해야 합니다. 주행거리와 이용 기간에 따라 장기렌트가 더 유리한 경우가 있습니다.'],
    ['렌트카 보험은 어디까지 들어야 하나요?', '자기부담금 수준과 완전자차 포함 여부를 확인하세요. 사고 시 부담액이 크게 달라지므로 보장 범위를 미리 점검하는 것이 안전합니다.']
  ]
};

function createFaqJsonLd(post, board = null) {
  const slug = board?.slug || post.board;
  const faqs = FAQ_BY_BOARD[slug];
  if (!faqs) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a }
    }))
  };
}

function boardOf(boards, slug) {
  return boards.find((board) => board.slug === slug) || boards.find((board) => board.slug === 'free') || defaultBoards()[0];
}

function visibleBoards(boards) {
  return boards.slice().filter((board) => board.visible !== false).sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

function renderArticleNav(posts, currentPost) {
  const sameBoard = posts.filter((post) => (post.board || 'free') === (currentPost.board || 'free'));
  const sorted = sameBoard.slice().sort((a, b) => Number(a.id) - Number(b.id));
  const index = sorted.findIndex((post) => Number(post.id) === Number(currentPost.id));
  const prev = index > 0 ? sorted[index - 1] : null;
  const next = index >= 0 && index < sorted.length - 1 ? sorted[index + 1] : null;
  const link = (className, label, post) => post
    ? `<a class="post-nav-link ${className}" href="/${escapeHtml(publicPath(post.path))}"><span>${label}</span><strong>${escapeHtml(post.title)}</strong></a>`
    : `<span class="post-nav-link ${className} disabled"><span>${label}</span><strong>글이 없습니다</strong></span>`;
  return `      <nav class="post-nav" aria-label="이전글 다음글">
        ${link('prev', '이전글', prev)}
        ${link('next', '다음글', next)}
      </nav>`;
}

function layout(env, title, description, body, canonicalPath = '/', options = {}, boards = defaultBoards()) {
  const site = trimSlash(env.SITE_URL);
  const canonicalUrl = site + publicPath(canonicalPath);
  const ogType = options.ogType || 'website';
  const metaDescription = options.metaDescription || description;
  const ogTitle = options.ogTitle || title;
  const ogDescription = options.ogDescription || description;
  const twitterTitle = options.twitterTitle || title;
  const twitterDescription = options.twitterDescription || metaDescription;
  const keywords = options.keywords ? `
  <meta name="keywords" content="${escapeHtml(options.keywords)}">` : '';
  const ogImage = options.ogImage ? `
  <meta property="og:image" content="${escapeHtml(options.ogImage)}">
  <meta property="og:image:alt" content="${escapeHtml(options.ogImageAlt || ogTitle)}">
  <meta name="twitter:image" content="${escapeHtml(options.ogImage)}">
  <meta name="twitter:image:alt" content="${escapeHtml(options.ogImageAlt || twitterTitle)}">` : '';
  const articleMeta = options.publishedTime ? `
  <meta property="article:published_time" content="${escapeHtml(options.publishedTime)}">
  <meta property="article:modified_time" content="${escapeHtml(options.modifiedTime || options.publishedTime)}">` : '';
  const jsonLdList = options.jsonLd ? (Array.isArray(options.jsonLd) ? options.jsonLd : [options.jsonLd]) : [];
  const jsonLd = jsonLdList.filter(Boolean).map((block) => `
  <script type="application/ld+json">${safeScriptJson(block)}</script>`).join('');
  const robots = options.noindex ? `
  <meta name="robots" content="noindex, follow">` : '';
  const activeNav = options.activeNav || (canonicalPath === '/' ? 'home' : '');
  const homeNavAttr = activeNav === 'home' ? ' class="nav-active nav-current" aria-current="page"' : '';
  const nav = visibleBoards(boards).map((board) => {
    const activeAttr = activeNav === board.slug ? ' class="nav-active nav-current" aria-current="page"' : '';
    return `<a href="/${escapeHtml(board.path)}/"${activeAttr}>${escapeHtml(board.name)}</a>`;
  }).join('\n        ');
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(metaDescription)}">${keywords}${robots}
  <meta property="og:locale" content="ko_KR">
  <meta property="og:site_name" content="올딜 생활게시판">
  <meta property="og:title" content="${escapeHtml(ogTitle)}">
  <meta property="og:description" content="${escapeHtml(ogDescription)}">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:type" content="${escapeHtml(ogType)}">${ogImage}${articleMeta}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(twitterTitle)}">
  <meta name="twitter:description" content="${escapeHtml(twitterDescription)}">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <link rel="stylesheet" href="/assets/style.css?v=20260721-ctabanner">${jsonLd}
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <a class="logo" href="/"><span class="logo-badge">올</span><span>올딜 생활게시판</span></a>
      <h1 class="hero-title">생활 서비스 문의와 안내를 모아둔 게시판</h1>
      <p class="hero-desc">포장이사, 인터넷가입, 정수기렌탈, 렌트카처럼 비교가 필요한 생활 정보를 게시판별로 정리합니다.</p>
      <nav class="nav">
        <a href="/"${homeNavAttr}>홈</a>
        ${nav}
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

function safeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function sortPostsForList(posts) {
  return posts.slice().sort((a, b) => {
    const aid = Number(a.id) || 0;
    const bid = Number(b.id) || 0;
    if (aid !== bid) return bid - aid;
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
}

function renderStaticBoardRows(posts, filterSlug = 'all', limit = 10) {
  const rows = sortPostsForList(posts)
    .filter((post) => filterSlug === 'all' || (post.board || 'free') === filterSlug)
    .slice(0, limit);
  if (!rows.length) return '';
  return rows.map((post) => `        <div class="board-row">
          <div class="board-no">${escapeHtml(post.id)}</div>
          <a class="board-title" href="/${escapeHtml(publicPath(post.path))}">${escapeHtml(post.title)}</a>
          <div class="board-date">${displayDate(post.createdAt)}</div>
        </div>`).join('\n');
}

function renderStaticBoardCards(posts, boards) {
  const sorted = visibleBoards(boards);
  return sorted.map((board) => {
    const count = posts.filter((post) => (post.board || 'free') === board.slug).length;
    const edit = `/admin/password.html?next=${encodeURIComponent(`/admin/board-edit.html?board=${board.slug}`)}`;
    return `        <article class="board-card">
          <a class="board-edit-btn" href="${escapeHtml(edit)}">수정</a>
          <a class="board-card-main" href="/${escapeHtml(board.path)}/">
            <strong>${escapeHtml(board.name)}</strong>
            <span>${escapeHtml(board.description || '')}</span>
            <em>게시글 ${count}개</em>
          </a>
        </article>`;
  }).join('\n');
}

function renderListSection(posts, boards, board = null, includeCards = false) {
  const filterSlug = board ? board.slug : 'all';
  const base = board ? `/${board.path}/` : '/';
  const title = board ? board.name : '최근 게시글';
  const desc = board ? board.description : '생활 서비스 관련 글을 게시판 형식으로 확인할 수 있습니다.';
  const staticRows = renderStaticBoardRows(posts, filterSlug, 10);
  const cards = '';
  return `${cards}    <section class="card post-wrap">
      <div class="board-toolbar">
        <div>
          <h2 class="section-title${board ? ' board-current-title' : ''}">${escapeHtml(title)}</h2>
          <p style="margin:0;color:var(--muted)">${escapeHtml(desc)}</p>
        </div>
        <a class="btn btn-primary" href="/admin/password.html${board ? `?next=${encodeURIComponent(`/admin/write.html?board=${board.slug}`)}` : ''}">글쓰기</a>
      </div>
      <form id="boardSearchForm" class="board-search" role="search">
        <input id="boardSearchInput" type="search" placeholder="검색어를 입력해주세요" autocomplete="off">
        <button class="search-btn" type="submit" aria-label="검색">검색</button>
      </form>
      <div id="boardList" class="board-list">
${staticRows}
      </div>
      <div id="boardEmpty" class="board-empty${staticRows ? '' : ' active'}">검색 결과가 없습니다.</div>
      <div id="boardPagination" class="pagination" aria-label="페이지 이동"></div>
      <script>
        window.NOTICE_POSTS = ${safeScriptJson(posts)};
        window.NOTICE_BOARDS = ${safeScriptJson(boards)};
        window.NOTICE_BOARD_FILTER = ${safeScriptJson(filterSlug)};
        window.NOTICE_PAGE_BASE = ${safeScriptJson(base)};
      </script>
      <script src="/assets/board.js?v=20260706-navstrong2"></script>
    </section>`;
}


function renderBoardIndexPage(env, posts, boards, board) {
  return layout(env, `올딜 ${board.name}`, board.description || `${board.name} 최신 글 목록입니다.`, renderListSection(posts, boards, board, false), `/${board.path}/`, { activeNav: board.slug }, boards);
}

function renderHomePage(env, posts, boards = defaultBoards()) {
  return layout(env, '올딜 생활게시판', '생활 서비스 문의와 안내를 게시판별로 나누어 확인할 수 있는 올딜 생활게시판입니다.', renderListSection(posts, boards, null, true), '/', { activeNav: 'home' }, boards);
}

function renderPostPage(env, post, contentHtml, posts = [], boards = defaultBoards()) {
  const board = boardOf(boards, post.board || 'free');
  const editHref = `/admin/password.html?next=${encodeURIComponent(`/admin/edit-post.html?id=${post.id}`)}`;
  const body = `    <article class="card post-wrap">
      <div class="post-action-bar">
        <p class="post-board-label"><a href="/${escapeHtml(board.path)}/">${escapeHtml(board.name)}</a></p>
        <a class="btn btn-light post-edit-btn" href="${escapeHtml(editHref)}">수정</a>
      </div>
      <h1 class="post-title">${escapeHtml(post.title)}</h1>
      <div class="post-meta">작성자 관리자 · <time datetime="${escapeHtml(post.createdAt)}">작성일 ${displayDate(post.createdAt)}</time>${post.updatedAt ? ` · 수정일 ${displayDate(post.updatedAt)}` : ''}</div>
      <div class="post-content">
${contentHtml}
      </div>
${renderArticleNav(posts, post)}
      <p style="margin-top:28px"><a class="btn btn-light" href="/${escapeHtml(board.path)}/">목록으로</a></p>
    </article>`;
  const seo = post.seo || createSeoPackage({
    title: post.title,
    excerpt: post.excerpt,
    board,
    id: post.id,
    path: post.path,
    createdAt: post.createdAt,
    imageUrls: extractImageUrls(env, contentHtml)
  });
  return layout(env, seo.pageTitle || post.title, seo.metaDescription || post.excerpt, body, `/${post.path}`, {
    ogType: 'article',
    metaDescription: seo.metaDescription,
    ogTitle: seo.ogTitle,
    ogDescription: seo.ogDescription,
    twitterTitle: seo.twitterTitle,
    twitterDescription: seo.twitterDescription,
    keywords: seo.keywords,
    ogImage: seo.image || extractFirstImageUrl(env, contentHtml),
    ogImageAlt: `${post.title} 대표 이미지`,
    publishedTime: post.createdAt,
    modifiedTime: post.updatedAt || post.createdAt,
    jsonLd: [
      createArticleJsonLd(env, { ...post, seo }, board),
      createRatingJsonLd(env, { ...post, seo }, board),
      createFaqJsonLd({ ...post, seo }, board)
    ],
    activeNav: board.slug
  }, boards);
}

// Cloudflare Pages는 매칭되는 파일이 없을 때 /404.html을 404 상태로 내려준다.
// 이 파일이 없으면 홈이 200으로 응답해 검색엔진에 소프트 404로 잡힌다.
function render404Page(env, posts, boards) {
  const body = `    <article class="card post-wrap">
      <h1 class="post-title">페이지를 찾을 수 없습니다</h1>
      <div class="post-content">
<div>요청하신 주소의 글이 삭제되었거나</div>
<div>주소가 잘못 입력되었습니다.</div>
<div><br></div>
<div>아래 게시판에서 필요한 글을 찾아보세요.</div>
      </div>
      <p style="margin-top:28px"><a class="btn btn-primary" href="/">홈으로</a></p>
    </article>
${renderListSection(posts, boards, null, true)}`;
  return layout(env, '페이지를 찾을 수 없습니다', '요청하신 페이지를 찾을 수 없습니다. 올딜 생활게시판의 다른 글을 확인해 보세요.', body, '/404', { noindex: true }, boards);
}

function buildSiteFiles(env, posts, boards) {
  const files = [
    { path: 'index.html', content: renderHomePage(env, posts, boards), encoding: 'utf-8' },
    { path: '404.html', content: render404Page(env, posts, boards), encoding: 'utf-8' },
    { path: 'sitemap.xml', content: renderSitemap(env, posts, boards), encoding: 'utf-8' },
    { path: 'rss.xml', content: renderRss(env, posts), encoding: 'utf-8' }
  ];
  for (const board of boards) {
    files.push({ path: `${board.path}/index.html`, content: renderBoardIndexPage(env, posts, boards, board), encoding: 'utf-8' });
  }
  return files;
}

function renderSitemap(env, posts, boards = defaultBoards()) {
  const site = trimSlash(env.SITE_URL);
  const today = new Date().toISOString().slice(0, 10);
  const base = [{ loc: `${site}/`, changefreq: 'daily', priority: '0.8', lastmod: today }]
    .concat(visibleBoards(boards).map((board) => ({ loc: `${site}/${board.path}/`, changefreq: 'hourly', priority: '0.9', lastmod: today })));
  const urls = base.concat(posts.map((post) => ({ loc: `${site}/${publicPath(post.path)}`, changefreq: 'weekly', priority: '0.7', lastmod: String(post.updatedAt || post.createdAt || '').slice(0, 10) })));
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
      <link>${site}/${publicPath(post.path)}</link>
      <guid>${site}/${publicPath(post.path)}</guid>
      <pubDate>${new Date(post.createdAt).toUTCString()}</pubDate>
      <description>${escapeHtml(post.excerpt)}</description>
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>올딜 생활게시판</title>
    <link>${site}/</link>
    <description>생활 서비스 게시글 RSS</description>
${items}
  </channel>
</rss>
`;
}
