(function(){
  var fallbackPosts = Array.isArray(window.NOTICE_POSTS) ? window.NOTICE_POSTS : [];
  var fallbackBoards = Array.isArray(window.NOTICE_BOARDS) ? window.NOTICE_BOARDS : [];
  var boardFilter = window.NOTICE_BOARD_FILTER || 'all';
  var pageBase = window.NOTICE_PAGE_BASE || location.pathname;
  var perPage = Number(window.NOTICE_PER_PAGE || 10) || 10;
  var currentPage = 1;
  var currentQuery = '';
  var allPosts = [];
  var boards = [];
  var list = document.getElementById('boardList');
  var initialListHtml = list ? list.innerHTML : '';
  var pagination = document.getElementById('boardPagination');
  var empty = document.getElementById('boardEmpty');
  var form = document.getElementById('boardSearchForm');
  var input = document.getElementById('boardSearchInput');

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch] || ch;
    });
  }
  function displayDate(value) {
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value || '').slice(0, 10).replace(/-/g,'.');
    return d.getFullYear() + '.' + String(d.getMonth()+1).padStart(2,'0') + '.' + String(d.getDate()).padStart(2,'0');
  }
  function normalize(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/&nbsp;/g, ' ')
      .replace(/[~!@#$%^&*()_+={}\[\]|\\:;"'<>,.?/`·ㆍ，。！？、]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function compact(value) {
    return normalize(value).replace(/\s+/g, '');
  }
  function makeSearchText(post) {
    var board = boards.find(function(b){ return b.slug === (post.board || 'free'); }) || {};
    return [
      post.id,
      post.title,
      post.excerpt,
      post.searchText,
      post.boardName,
      post.board,
      board.name,
      board.description,
      post.path
    ].join(' ');
  }
  function queryMatches(post, query) {
    var q = normalize(query);
    if (!q) return true;
    var target = normalize(makeSearchText(post));
    var targetCompact = target.replace(/\s+/g, '');
    var qCompact = q.replace(/\s+/g, '');
    if (target.indexOf(q) !== -1 || targetCompact.indexOf(qCompact) !== -1) return true;
    var tokens = q.split(' ').filter(Boolean);
    if (!tokens.length) return true;
    return tokens.every(function(token){
      return target.indexOf(token) !== -1 || targetCompact.indexOf(token.replace(/\s+/g, '')) !== -1;
    });
  }
  function sortPosts(rows) {
    return rows.slice().sort(function(a,b){
      var aid=Number(a.id)||0, bid=Number(b.id)||0;
      if(aid!==bid) return bid-aid;
      return new Date(b.createdAt||0)-new Date(a.createdAt||0);
    });
  }
  function mergePendingPosts(basePosts) {
    var base = Array.isArray(basePosts) ? basePosts.slice() : [];
    var keys = {};
    base.forEach(function(post){ keys[String(post.id || post.path)] = true; });
    var pending = [];
    try { pending = JSON.parse(localStorage.getItem('notice_pending_posts') || '[]'); if(!Array.isArray(pending)) pending=[]; } catch(_) { pending=[]; }
    var now = Date.now();
    var keep = [];
    pending.forEach(function(post){
      if(!post || !post.path) return;
      var key = String(post.id || post.path);
      var savedAt = Number(post.savedAtMs || 0);
      if(savedAt && now - savedAt > 24*60*60*1000) return;
      if(keys[key]) return;
      keys[key] = true;
      keep.push(post);
      base.unshift(post);
    });
    try { keep.length ? localStorage.setItem('notice_pending_posts', JSON.stringify(keep.slice(0,20))) : localStorage.removeItem('notice_pending_posts'); } catch(_) {}
    return sortPosts(base);
  }
  function visiblePosts() {
    var rows = allPosts.slice();
    if (boardFilter !== 'all') rows = rows.filter(function(post){ return (post.board || 'free') === boardFilter; });
    if (currentQuery) rows = rows.filter(function(post){ return queryMatches(post, currentQuery); });
    return sortPosts(rows);
  }
  function renderRows(rows) {
    if(!list) return;
    if(!rows.length) {
      list.innerHTML = '';
      if(empty) empty.classList.add('active');
      return;
    }
    if(empty) empty.classList.remove('active');
    list.innerHTML = rows.map(function(post){
      return '<div class="board-row">' +
        '<div class="board-no">' + escapeHtml(post.id) + '</div>' +
        '<a class="board-title" href="/' + escapeHtml(post.path) + '">' + escapeHtml(post.title) + '</a>' +
        '<div class="board-date">' + displayDate(post.createdAt) + '</div>' +
      '</div>';
    }).join('');
  }
  function pageButton(label,page,active,disabled){
    var btn=document.createElement('button');
    btn.type='button';
    btn.className='page-btn'+(active?' active':'');
    btn.textContent=label;
    btn.disabled=!!disabled;
    if(!disabled) btn.addEventListener('click', function(){ currentPage=page; render(true); });
    return btn;
  }
  function renderPagination(totalPages){
    if(!pagination) return;
    pagination.innerHTML='';
    if(totalPages<=1) return;
    var blockStart=Math.floor((currentPage-1)/10)*10+1;
    var blockEnd=Math.min(blockStart+9,totalPages);
    pagination.appendChild(pageButton('‹',Math.max(1,blockStart-10),false,blockStart===1));
    for(var i=blockStart;i<=blockEnd;i++) pagination.appendChild(pageButton(String(i),i,i===currentPage,false));
    pagination.appendChild(pageButton('›',Math.min(totalPages,blockStart+10),false,blockEnd>=totalPages));
  }
  function updateUrl(){
    var params=new URLSearchParams();
    if(currentQuery) params.set('q',currentQuery);
    if(currentPage>1) params.set('page',String(currentPage));
    var qs=params.toString();
    history.replaceState({q:currentQuery,page:currentPage},'',qs ? pageBase + '?' + qs : pageBase);
  }
  function render(syncUrl){
    var rows=visiblePosts();
    var totalPages=Math.max(1,Math.ceil(rows.length/perPage));
    currentPage=Math.max(1,Math.min(currentPage,totalPages));
    var start=(currentPage-1)*perPage;
    renderRows(rows.slice(start,start+perPage));
    renderPagination(totalPages);
    if(syncUrl) updateUrl();
  }
  function loadFromUrl(){
    var params=new URLSearchParams(location.search);
    currentQuery=params.get('q')||'';
    currentPage=Math.max(1,parseInt(params.get('page')||'1',10)||1);
    if(input) input.value=currentQuery;
    render(false);
  }
  function renderBoardCards(){
    // 홈의 게시판 바로가기 카드 문구는 제거했습니다. 기존 HTML에 boardCards가 없어도 오류 없이 종료됩니다.
    var wrap=document.getElementById('boardCards');
    if(!wrap) return;
    wrap.innerHTML='';
  }
  async function boot(){
    allPosts=fallbackPosts.slice();
    boards=fallbackBoards.slice();
    try {
      var postRes=await fetch('/data/posts.json?ts=' + Date.now(), {cache:'no-store'});
      if(postRes.ok) {
        var fetchedPosts = await postRes.json();
        if(Array.isArray(fetchedPosts)) allPosts=fetchedPosts;
      }
    } catch(_) {}
    try {
      var boardRes=await fetch('/data/boards.json?ts=' + Date.now(), {cache:'no-store'});
      if(boardRes.ok) {
        var fetchedBoards = await boardRes.json();
        if(Array.isArray(fetchedBoards)) boards=fetchedBoards;
      }
    } catch(_) {}
    if(!Array.isArray(allPosts)) allPosts=[];
    if(!Array.isArray(boards)) boards=[];
    if(!allPosts.length && initialListHtml) {
      // posts.json을 못 읽어도 정적 목록은 그대로 보입니다.
      if(empty) empty.classList.remove('active');
    }
    allPosts=mergePendingPosts(allPosts);
    renderBoardCards();
    loadFromUrl();
  }
  if(form) form.addEventListener('submit', function(event){
    event.preventDefault();
    currentQuery=(input ? input.value : '').trim();
    currentPage=1;
    render(true);
  });
  if(input) input.addEventListener('input', function(){
    if(!input.value.trim() && currentQuery) {
      currentQuery='';
      currentPage=1;
      render(true);
    }
  });
  window.addEventListener('popstate', loadFromUrl);
  boot();
})();
