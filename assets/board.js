(function(){
  var fallbackPosts = Array.isArray(window.NOTICE_POSTS) ? window.NOTICE_POSTS : [];
  var fallbackBoards = Array.isArray(window.NOTICE_BOARDS) ? window.NOTICE_BOARDS : [];
  var boardFilter = window.NOTICE_BOARD_FILTER || 'all';
  var pageBase = window.NOTICE_PAGE_BASE || location.pathname;
  var perPage = 10;
  var currentPage = 1;
  var currentQuery = '';
  var allPosts = [];
  var boards = [];
  var list = document.getElementById('boardList');
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
  function normalize(value) { return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
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
    var q = normalize(currentQuery);
    if (q) rows = rows.filter(function(post){
      var target = normalize([post.id, post.title, post.excerpt, post.searchText, post.boardName].join(' '));
      return target.indexOf(q) !== -1;
    });
    return sortPosts(rows);
  }
  function renderRows(rows) {
    if(!list) return;
    if(!rows.length) { list.innerHTML=''; if(empty) empty.classList.add('active'); return; }
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
    var btn=document.createElement('button'); btn.type='button'; btn.className='page-btn'+(active?' active':''); btn.textContent=label; btn.disabled=!!disabled;
    if(!disabled) btn.addEventListener('click', function(){ currentPage=page; render(true); });
    return btn;
  }
  function renderPagination(totalPages){
    if(!pagination) return; pagination.innerHTML=''; if(totalPages<=1) return;
    var blockStart=Math.floor((currentPage-1)/10)*10+1; var blockEnd=Math.min(blockStart+9,totalPages);
    pagination.appendChild(pageButton('‹',Math.max(1,blockStart-10),false,blockStart===1));
    for(var i=blockStart;i<=blockEnd;i++) pagination.appendChild(pageButton(String(i),i,i===currentPage,false));
    pagination.appendChild(pageButton('›',Math.min(totalPages,blockStart+10),false,blockEnd>=totalPages));
  }
  function updateUrl(){
    var params=new URLSearchParams(); if(currentQuery) params.set('q',currentQuery); if(currentPage>1) params.set('page',String(currentPage));
    var qs=params.toString(); history.replaceState({q:currentQuery,page:currentPage},'',qs ? pageBase + '?' + qs : pageBase);
  }
  function render(syncUrl){
    var rows=visiblePosts(); var totalPages=Math.max(1,Math.ceil(rows.length/perPage)); currentPage=Math.max(1,Math.min(currentPage,totalPages));
    var start=(currentPage-1)*perPage; renderRows(rows.slice(start,start+perPage)); renderPagination(totalPages); if(syncUrl) updateUrl();
  }
  function loadFromUrl(){
    var params=new URLSearchParams(location.search); currentQuery=params.get('q')||''; currentPage=Math.max(1,parseInt(params.get('page')||'1',10)||1);
    if(input) input.value=currentQuery; render(false);
  }
  function renderBoardCards(){
    var wrap=document.getElementById('boardCards'); if(!wrap || !boards.length) return;
    var sorted=boards.slice().filter(function(b){ return b.visible !== false; }).sort(function(a,b){ return (a.order||0)-(b.order||0); });
    wrap.innerHTML=sorted.map(function(board){
      var count=allPosts.filter(function(post){ return (post.board||'free')===board.slug; }).length;
      var href='/' + board.path + '/';
      var edit='/admin/password.html?next=' + encodeURIComponent('/admin/board-edit.html?board=' + board.slug);
      return '<article class="board-card">' +
        '<a class="board-edit-btn" href="' + edit + '">수정</a>' +
        '<a class="board-card-main" href="' + href + '">' +
          '<strong>' + escapeHtml(board.name) + '</strong>' +
          '<span>' + escapeHtml(board.description || '') + '</span>' +
          '<em>게시글 ' + count + '개</em>' +
        '</a>' +
      '</article>';
    }).join('');
  }
  async function boot(){
    allPosts=fallbackPosts; boards=fallbackBoards;
    try {
      var postRes=await fetch('/data/posts.json?ts=' + Date.now(), {cache:'no-store'});
      if(postRes.ok) allPosts=await postRes.json();
    } catch(_) {}
    try {
      var boardRes=await fetch('/data/boards.json?ts=' + Date.now(), {cache:'no-store'});
      if(boardRes.ok) boards=await boardRes.json();
    } catch(_) {}
    if(!Array.isArray(allPosts)) allPosts=[]; if(!Array.isArray(boards)) boards=[];
    allPosts=mergePendingPosts(allPosts);
    renderBoardCards(); loadFromUrl();
  }
  if(form) form.addEventListener('submit', function(event){ event.preventDefault(); currentQuery=(input ? input.value : '').trim(); currentPage=1; render(true); });
  window.addEventListener('popstate', loadFromUrl);
  boot();
})();
