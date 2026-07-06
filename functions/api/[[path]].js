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
  const imageUrls = extractImageUrls(env, contentHtml);
  const seo = createSeoPackage({ title, excerpt, board, id: nextId, path, createdAt, imageUrls });
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
  const imageUrls = extractImageUrls(env, contentHtml);
  const seo = createSeoPackage({
    title,
    excerpt,
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
    url: `${trimSlash(env.SITE_URL)}/${current.path}`
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

function createSeoPackage({ title, excerpt, board, id, path, createdAt, imageUrls }) {
  const boardName = board?.name || '생활게시판';
  const base = normalizeForSeoText(excerpt, 110) || `${title} 관련 내용을 ${boardName}에서 확인할 수 있습니다.`;
  const seed = Number(id) || Date.now();
  const pageTitle = pickVariant([
    `${title} | ${boardName}`,
    `${title} - ${boardName} 안내`,
    `${boardName}에서 보는 ${title}`
  ], seed);
  const metaDescription = clipSentence(pickVariant([
    `${base} 핵심 내용을 부담 없이 읽을 수 있도록 정리했습니다.`,
    `${title}에 대해 궁금한 부분을 빠르게 훑어볼 수 있게 구성한 글입니다.`,
    `${boardName} 주제에 맞춰 ${title} 내용을 자연스럽게 풀어낸 게시글입니다.`
  ], seed + 1), 155);
  const ogDescription = clipSentence(pickVariant([
    `${title} 관련 내용을 이야기 흐름으로 정리했습니다. 필요한 정보만 가볍게 확인해보세요.`,
    `${boardName}에서 다루는 ${title} 글입니다. 검색자가 궁금해할 만한 포인트를 중심으로 담았습니다.`,
    `${base} 읽기 편한 문장으로 구성해 처음 보는 분도 쉽게 따라갈 수 있습니다.`
  ], seed + 2), 165);
  const twitterDescription = clipSentence(pickVariant([
    `${title} 요점을 짧게 확인하고 이어서 본문에서 자세한 내용을 볼 수 있습니다.`,
    `${boardName} 최신 글로 등록된 ${title} 안내입니다.`,
    `${base} 모바일에서도 읽기 좋게 정리했습니다.`
  ], seed + 3), 150);
  const jsonLdDescription = clipSentence(pickVariant([
    `${title} 게시글은 ${boardName} 성격에 맞춰 주제 설명과 읽을거리를 함께 제공하는 문서입니다.`,
    `${boardName}에 등록된 ${title} 콘텐츠로, 본문과 이미지 정보를 포함해 구성된 글입니다.`,
    `${title}에 대한 본문 내용을 바탕으로 작성일, 게시판, 이미지 정보를 함께 제공하는 Article 문서입니다.`
  ], seed + 4), 170);
  const keywordSet = Array.from(new Set([
    title,
    boardName.replace(/ 게시판$/, ''),
    boardName,
    ...String(title).split(/[\s,·|/]+/).filter((word) => word.length > 1).slice(0, 5)
  ])).slice(0, 8);
  return {
    pageTitle,
    metaDescription,
    ogTitle: pickVariant([title, `${title} 안내`, `${boardName} ${title}`], seed + 5),
    ogDescription,
    twitterTitle: pickVariant([title, `${title} 요약`, `${boardName} 글 보기`], seed + 6),
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
  const url = `${trimSlash(env.SITE_URL)}/${post.path}`;
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
    ? `<a class="post-nav-link ${className}" href="/${escapeHtml(post.path)}"><span>${label}</span><strong>${escapeHtml(post.title)}</strong></a>`
    : `<span class="post-nav-link ${className} disabled"><span>${label}</span><strong>글이 없습니다</strong></span>`;
  return `      <nav class="post-nav" aria-label="이전글 다음글">
        ${link('prev', '이전글', prev)}
        ${link('next', '다음글', next)}
      </nav>`;
}

function layout(env, title, description, body, canonicalPath = '/', options = {}, boards = defaultBoards()) {
  const site = trimSlash(env.SITE_URL);
  const canonicalUrl = site + canonicalPath;
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
  const jsonLd = options.jsonLd ? `
  <script type="application/ld+json">${safeScriptJson(options.jsonLd)}</script>` : '';
  const nav = visibleBoards(boards).map((board) => `<a href="/${escapeHtml(board.path)}/">${escapeHtml(board.name)}</a>`).join('\n        ');
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(metaDescription)}">${keywords}
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
  <link rel="stylesheet" href="/assets/style.css">${jsonLd}
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <a class="logo" href="/"><span class="logo-badge">올</span><span>올딜 생활게시판</span></a>
      <h1 class="hero-title">생활 서비스 문의와 안내를 모아둔 게시판</h1>
      <p class="hero-desc">포장이사, 인터넷가입, 정수기렌탈, 렌트카처럼 비교가 필요한 생활 정보를 게시판별로 정리합니다.</p>
      <nav class="nav">
        <a href="/">홈</a>
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

function renderListSection(posts, boards, board = null, includeCards = false) {
  const filterSlug = board ? board.slug : 'all';
  const base = board ? `/${board.path}/` : '/';
  const title = board ? board.name : '최근 게시글';
  const desc = board ? board.description : '생활 서비스 관련 글을 게시판 형식으로 확인할 수 있습니다.';
  const cards = includeCards ? `    <section class="board-card-section">
      <div class="board-section-head">
        <h2 class="section-title">게시판 바로가기</h2>
        <p>원하는 주제의 게시판으로 이동해서 글을 확인할 수 있습니다.</p>
      </div>
      <div id="boardCards" class="board-card-grid"></div>
    </section>
` : '';
  return `${cards}    <section class="card post-wrap">
      <div class="board-toolbar">
        <div>
          <h2 class="section-title">${escapeHtml(title)}</h2>
          <p style="margin:0;color:var(--muted)">${escapeHtml(desc)}</p>
        </div>
        <a class="btn btn-primary" href="/admin/password.html${board ? `?next=${encodeURIComponent(`/admin/write.html?board=${board.slug}`)}` : ''}">글쓰기</a>
      </div>
      <form id="boardSearchForm" class="board-search" role="search">
        <input id="boardSearchInput" type="search" placeholder="검색어를 입력해주세요" autocomplete="off">
        <button class="search-btn" type="submit" aria-label="검색">검색</button>
      </form>
      <div id="boardList" class="board-list"></div>
      <div id="boardEmpty" class="board-empty">검색 결과가 없습니다.</div>
      <div id="boardPagination" class="pagination" aria-label="페이지 이동"></div>
      <script>
        window.NOTICE_POSTS = ${safeScriptJson(posts)};
        window.NOTICE_BOARDS = ${safeScriptJson(boards)};
        window.NOTICE_BOARD_FILTER = ${safeScriptJson(filterSlug)};
        window.NOTICE_PAGE_BASE = ${safeScriptJson(base)};
      </script>
      <script src="/assets/board.js"></script>
    </section>`;
}

function renderBoardIndexPage(env, posts, boards, board) {
  return layout(env, `올딜 ${board.name}`, board.description || `${board.name} 최신 글 목록입니다.`, renderListSection(posts, boards, board, false), `/${board.path}/`, {}, boards);
}

function renderHomePage(env, posts, boards = defaultBoards()) {
  return layout(env, '올딜 생활게시판', '생활 서비스 문의와 안내를 게시판별로 나누어 확인할 수 있는 올딜 생활게시판입니다.', renderListSection(posts, boards, null, true), '/', {}, boards);
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
    jsonLd: createArticleJsonLd(env, { ...post, seo }, board)
  }, boards);
}

function buildSiteFiles(env, posts, boards) {
  const files = [
    { path: 'index.html', content: renderHomePage(env, posts, boards), encoding: 'utf-8' },
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
    <link>${site}/</link>
    <description>생활 서비스 게시글 RSS</description>
${items}
  </channel>
</rss>
`;
}
